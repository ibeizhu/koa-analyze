
'use strict';

/**
 * Module dependencies.
 */

const isGeneratorFunction = require('is-generator-function');
const debug = require('debug')('koa:application');
const onFinished = require('on-finished');
const response = require('./response');
const compose = require('koa-compose');
const isJSON = require('koa-is-json');
const context = require('./context');
const request = require('./request');
const statuses = require('statuses');
const Cookies = require('cookies');
const accepts = require('accepts');
const Emitter = require('events');
const assert = require('assert');
const Stream = require('stream');
const http = require('http');
const only = require('only');
const convert = require('koa-convert');
const deprecate = require('depd')('koa');

/**
 * Expose `Application` class.
 * Inherits from `Emitter.prototype`.
 */

module.exports = class Application extends Emitter {
  /**
   * Initialize a new `Application`.
   *
   * @api public
   */

  constructor() {
    super();

    this.proxy = false;
    // 存放中间件
    this.middleware = [];
    this.subdomainOffset = 2;
    this.env = process.env.NODE_ENV || 'development';
    // 创建原型对象
    // obj = Object.create(context) => obj= {};obj.__proto__ = context;
    this.context = Object.create(context);
    this.request = Object.create(request);
    this.response = Object.create(response);
  }


  /**
   * Return JSON representation.
   * We only bother showing settings.
   *
   * @return {Object}
   * @api public
   */

  toJSON() {
    return only(this, [
      'subdomainOffset',
      'proxy',
      'env'
    ]);
  }

  /**
   * Inspect implementation.
   *
   * @return {Object}
   * @api public
   */

  inspect() {
    return this.toJSON();
  }

  /**
   * Use the given middleware `fn`.
   * 安装中间件函数
   * Old-style middleware will be converted.
   *
   * @param {Function} fn
   * @return {Application} self
   * @api public
   */

  use(fn) {
    if (typeof fn !== 'function') throw new TypeError('middleware must be a function!');
    // koa v3 版本即将不支持 generator function 形式
    if (isGeneratorFunction(fn)) {
      deprecate('Support for generators will be removed in v3. ' +
                'See the documentation for examples of how to convert old middleware ' +
                'https://github.com/koajs/koa/blob/master/docs/migration.md');
      // 内部使用 co 函数库对 generator function 进行转换
      fn = convert(fn);
    }
    debug('use %s', fn._name || fn.name || '-');
    // middleware是一个数组，存储所有的中间件函数，
    // 每个中间件函数的形参都是 fn(ctx,next)
    this.middleware.push(fn);
    return this;
  }

  /**
   * Shorthand for:
   *
   *    http.createServer(app.callback()).listen(...)
   *
   * @param {Mixed} ...
   * @return {Server}
   * @api public
   */

  listen(...args) {
    debug('listen');
    // koa 的http 请求入口，createServer
    // this.callback() 封装中间件函数
    const server = http.createServer(this.callback());
    return server.listen(...args);
  }

  /**
   * Return a request handler callback
   * for node's native http server.
   *
   * @return {Function}
   * @api public
   */

  callback() {
    // 对中间件数组进行组合成串行函数，依次执行
    const fn = compose(this.middleware);
    if (!this.listeners('error').length) this.on('error', this.onerror);

    log('callback');
    return (req, res) => {
      log('handle request entry');
      const ctx = this.createContext(req, res);
      return this.handleRequest(ctx, fn);
    };
  }

  /**
   * Initialize a new context.
   *
   * @api private
   */

  createContext(req, res) {
    const context = Object.create(this.context);
    // 扩展的 request 对象方法
    const request = context.request = Object.create(this.request);
    // 扩展的 response 对象方法
    const response = context.response = Object.create(this.response);
    context.app = request.app = response.app = this;
    // req是 node http模块 自带的request对象
    context.req = request.req = response.req = req;
    // res是 node http模块 自带的response对象
    context.res = request.res = response.res = res;
    request.ctx = response.ctx = context;
    request.response = response;
    response.request = request;
    context.originalUrl = request.originalUrl = req.url;
    // 设置 cookie
    // secure：标志 http || https
    // TODO Moment keys 字段如何取到的？
    context.cookies = new Cookies(req, res, {
      keys: this.keys,
      secure: request.secure
    });
    request.ip = request.ips[0] || req.socket.remoteAddress || '';
    context.accept = request.accept = accepts(req);
    context.state = {};
    return context;
  }

  /**
   * Handle request in callback.
   *
   * @api private
   */

  handleRequest(ctx, fnMiddleware) {
    const res = ctx.res;
    res.statusCode = 404;
    const onerror = err => ctx.onerror(err);
    const handleResponse = () => respond(ctx);
    // TODO Moment onFinished 代码没有精读
    onFinished(res, onerror);
    // fnMiddleware(ctx)：执行中间件函数,一系列的递归 Promise 串行执行
    // handleResponse：中间件执行完毕后，执行对 response 的处理
    return fnMiddleware(ctx,()=>{}).then(handleResponse).catch(onerror);
  }


  /**
   * Default error handler.
   *
   * @param {Error} err
   * @api private
   */

  onerror(err) {
    assert(err instanceof Error, `non-error thrown: ${err}`);

    if (404 == err.status || err.expose) return;
    if (this.silent) return;

    const msg = err.stack || err.toString();
    console.error();
    console.error(msg.replace(/^/gm, '  '));
    console.error();
  }
};

/**
 * Response helper.
 */

function respond(ctx) {
  // ctx.respond 允许代码手动控制绕过默认的 response 处理
  // allow bypassing koa
  if (false === ctx.respond) return;

  const res = ctx.res;
  // writable: response 已结束 || socket response 都不可写
  if (!ctx.writable) return;

  let body = ctx.body;
  const code = ctx.status;

  // ignore body
  if (statuses.empty[code]) {
    // strip headers
    ctx.body = null;
    return res.end();
  }

  log('res.headersSent',res.headersSent);
  log('body type is buffer :',Buffer.isBuffer(body));
  log('body type is String :','string' == typeof body);
  log('body type is Stream:',body instanceof Stream);
  if ('HEAD' == ctx.method) {
    if (!res.headersSent && isJSON(body)) {
      ctx.length = Buffer.byteLength(JSON.stringify(body));
    }
    return res.end();
  }

  // status body
  if (null == body) {
    body = ctx.message || String(code);
    if (!res.headersSent) {
      ctx.type = 'text';
      ctx.length = Buffer.byteLength(body);
    }
    return res.end(body);
  }

  // responses
  if (Buffer.isBuffer(body)) return res.end(body);
  if ('string' == typeof body) return res.end(body);
  if (body instanceof Stream) return body.pipe(res);

  // body: json
  body = JSON.stringify(body);
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body);
  }
  res.end(body);
}
