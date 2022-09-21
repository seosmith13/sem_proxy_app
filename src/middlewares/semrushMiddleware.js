const {
  createProxyMiddleware,
  responseInterceptor
} = require('http-proxy-middleware');
const cheerio = require('cheerio');
const axios = require('axios');
const config = require('../services/config');
const domainOverview = require('../models/domainOverview');
const keywordOverview = require('../models/keywordOverview');

/**
 * Convert data based on form-submit to query-string
 * @param {*} data 
 * @returns 
 */
const getFormQueryString = (data) => {
  let items = [];
  Object.keys(data).forEach((key, idx) => {
    if (Array.isArray(data[key])) {
      for (let item of data[key]) {
        items.push(key + "[]" + '=' + encodeURIComponent(item));
      }
    } else {
      items.push(key + '=' + encodeURIComponent(data[key]));
    }
  });
  let dataQuery = items.join('&');
  return dataQuery;
}
/** Setting proxy to send all the requests that comes from wp site into this nodeapp to www.semrush.com */
const semrushProxy = (prefix) => {
  return createProxyMiddleware({
    target: `https://${prefix}.semrush.com`,
    selfHandleResponse: true,
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {// Subscribe to http-proxy's proxyReq event
      // Intercept proxy request and set UserAgent and cookie of first session
      let { userAgent, cookie } = config.getConfig();
      proxyReq.setHeader('user-agent', userAgent);
      proxyReq.setHeader('Cookie', cookie);
      // Fix the body-parser module
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {

        let contentType = proxyReq.getHeader('content-type');
        let writeBody = bodyData => {
          proxyReq.setHeader('content-length', Buffer.byteLength(bodyData));
          proxyReq.write(bodyData);
        }
        if (contentType && contentType.includes('application/json')) {
          writeBody(JSON.stringify(req.body));
        }
        if (contentType && contentType.includes('application/x-www-form-urlencoded')) {
          let params = getFormQueryString(req.body);
          proxyReq.setHeader("content-type", "application/x-www-form-urlencoded");
          writeBody(params);
        }
      }
    },
    onProxyRes: responseInterceptor(// Subscribe to http-proxy's proxyRes event.
      (responseBuffer, proxyRes, req, res) => {// Ignore static file
        if (req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) return responseBuffer;
        // Log the activity
        // axios.post(`${process.env.ADMIN_DOMAIN}/logs/semrush`, {
        //     log: `${req.user.username} ${req.wpSite} ${req.headers['user-agent']} ${req.url} ${proxyRes.statusCode}`
        // }).then((data) => {
        //     console.log(data);
        // });
        if (proxyRes.headers['location']) {// Rewrite the location to the domain of nodeapp
          let locale = "";
          try {
            let url = new URL(proxyRes.headers.location);
            target = url.origin;
            locale = url.hostname.split(".")[0];
          } catch (err) {
            target = `https://${prefix}.semrush.com`;
          }
          if (proxyRes.statusCode == 302) {
            proxyRes.headers['location'].replace(target, `${process.env.DOMAIN}/lang?locale=${locale}`);
            res.setHeader('location', proxyRes.headers['location'].replace(target, `${process.env.DOMAIN}/lang?locale=${locale}`));
          } else {
            proxyRes.headers['location'].replace(target, process.env.DOMAIN);
            res.setHeader('location', proxyRes.headers['location'].replace(target, process.env.DOMAIN));
          }
        }
        if (proxyRes.headers['content-type'] && proxyRes.headers['content-type'].includes('text/html')) {

          let response = responseBuffer.toString('utf-8');
          let $ = cheerio.load(response);
          $('head').append(`<script src="/public/js/index.js" type="text/javascript"></script>`);
          $('.srf-header .srf-navbar__right .srf-login-btn, .srf-header .srf-navbar__right .srf-register-btn').remove();
          $('.srf-dropdown.srf-switch-locale-trigger').remove();

          if (req.user.isAdmin) {
            return $.html();
          } else {// Remove the account information if client is normal user
            if (req.url == "/accounts/profile/account-info" || req.url == "/billing-admin/profile/subscription") {
              $('.srf-layout__sidebar, .srf-layout__body').remove();
              $('.srf-layout__footer').before("<h1 style='grid-area: footer; display: block; margin-top: -150px; text-align: center; font-size: 40px; color: #ff642d; font-weight: bold'>You can not access in this page.</h1>");
            }
            $('.srf-navbar__right').remove();
            return $.html();
          }
        }
        return responseBuffer;
      }
    ),
    prependPath: true,
    secure: false,
    hostRewrite: true,
    headers: {
      referer: `https://${prefix}.semrush.com`,
      origin: `https://${prefix}.semrush.com`
    },
    autoRewrite: true,
    ws: true
  });
}

const domainOverviewMiddleware = async (req, res, next) => {
  if (
    req.method === "POST" &&
    !Array.isArray(req.body) &&
    req.body.method === "dpa.IsRootDomain" &&
    req.body.params.report === "domain.overview"
  ) {
    const total = await domainOverview.countRequests(req.user.id, req.user.username, req.wpSite);
    if (total > config.getConfig().domainOverviewLimit) {
      return res.json({
        error: {
          code: "-1",
          message: "reached limit",
        },
      });
    } else {
      await domainOverview.create({
        userId: req.user.id,
        username: req.user.username,
        site: req.wpSite,
        domain: req.body.params.args.searchItem,
      });
      next();
    }
  } else {
    next();
  }
};
const keywordOverviewMiddleware = async (req, res, next) => {
  if (
    req.method === "POST" &&
    req.url.includes("/kwogw/rpc") &&
    req.body.method === "keywords.GetInfo"
  ) {
    const total = await keywordOverview.countRequests(
      req.user.id,
      req.user.username,
      req.wpSite
      );
    if (total > config.getConfig().keywordOverviewLimit) {
      return res.json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "daily limit exceed", data: null },
        id: 1,
      });
    } else {
      await keywordOverview.create({
        userId: req.user.id,
        username: req.user.username,
        site: req.wpSite,
        phases: req.body.params.phrases,
      });
      next();
    }
  } else {
    next();
  }
};
module.exports = {
  semrushProxy,
  domainOverviewMiddleware,
  keywordOverviewMiddleware
}