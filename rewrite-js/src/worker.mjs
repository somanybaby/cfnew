import { connect } from 'cloudflare:sockets';
import { createApp } from './app.mjs';

export default createApp(connect);
