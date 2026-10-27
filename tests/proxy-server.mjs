import { createRoutingProxy } from '../src/routing-proxy.js';

const hosts = (process.env.HOSTS ?? '').split(',').filter(Boolean);
const all = process.env.ALL === '1';
const port = Number(process.env.PORT ?? 49226);
const server = process.env.SERVER ?? '127.0.0.1:10901';

const proxy = createRoutingProxy({ rules: () => ({ hosts, all, server }), port });
await proxy.listen();
console.log(`routing proxy on ${port} | hosts: ${hosts.join(', ') || '(none)'} | all: ${all}`);
