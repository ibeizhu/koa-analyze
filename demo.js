/**
 * Created by beizhu on 2018/4/2.
 */

const Koa = require('./lib/application');
const app = new Koa();
global.log = console.log.bind(this);

app
  .use(function(ctx, next) {
    log(ctx.req.url);
    console.log('1');
    ctx.body = 'World1';
    log(ctx.method);
    next();
  })
  .use(function(ctx, next) {
    console.log('2');
    ctx.body = 'World2';
    next();
  })
  .use(function(ctx) {
    log(typeof ctx.app.middleware[0]);
    console.log('3');
    ctx.body = 'World3';
  });

app.listen(3000);
