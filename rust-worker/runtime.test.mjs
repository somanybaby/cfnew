import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Miniflare, Log, LogLevel } from 'miniflare';

const user = '00000000-1111-4222-8333-444444444444';
const userBytes = Buffer.from(user.replaceAll('-', ''), 'hex');
function vless(port) { return Buffer.concat([Buffer.from([0]),userBytes,Buffer.from([0,1,port>>8,port&255,1,127,0,0,1])]); }
function trojan(port) { return Buffer.concat([Buffer.from(createHash('sha224').update(user).digest('hex')+'\r\n'),Buffer.from([1,1,127,0,0,1,port>>8,port&255,13,10])]); }
function message(ws) { return new Promise((resolve,reject) => {
  const timer=setTimeout(()=>reject(Error('Timed out waiting for TCP echo')),8000);
  ws.addEventListener('message',e=>{clearTimeout(timer);resolve(Buffer.from(e.data));},{once:true});
  ws.addEventListener('close',()=>{clearTimeout(timer);reject(Error('WebSocket closed before echo'));},{once:true});
}); }

test('Rust/Wasm authenticates config, preserves settings, and streams VLESS/Trojan TCP', {timeout:30000}, async () => {
  const sockets=new Set();
  const proxies=[];
  const echo=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.on('data',data=>socket.write(data));});
  echo.listen(0,'127.0.0.1');await once(echo,'listening');const port=echo.address().port;
  const mf=new Miniflare({
    modules:[{type:'ESModule',path:'dist/rust/worker.mjs'},{type:'CompiledWasm',path:'dist/rust/index_bg.wasm'}],
    compatibilityDate:'2026-01-20',bindings:{u:user},kvNamespaces:['C'],log:new Log(LogLevel.ERROR),
  });
  try {
    const kv=await mf.getKVNamespace('C');await kv.put('c',JSON.stringify({ev:'yes',et:'yes',ex:'yes',ispUnicom:'yes',ena:'yes',ech:'yes'}));
    const root=await mf.dispatchFetch('https://worker.example/');assert.equal(await root.text(),'hello');
    const config=await mf.dispatchFetch('https://worker.example/'+user+'/api/config');
    assert.equal(config.status,200,await config.clone().text());const data=await config.json();
    assert.equal(data.uuid,user);assert.equal(data.implementation,'rust-wasm-0.1.0');assert.equal(data.ispUnicom,'yes');assert.equal(data.kvEnabled,true);
    const wrong=await mf.dispatchFetch('https://worker.example/10000000-1111-4222-8333-444444444444/api/config');assert.equal(wrong.status,404);
    const invalid=await mf.dispatchFetch('https://worker.example/'+user+'/api/config',{method:'POST',body:JSON.stringify({u:'forbidden'})});assert.equal(invalid.status,400);
    const update=await mf.dispatchFetch('https://worker.example/'+user+'/api/config',{method:'POST',body:JSON.stringify({ena:'no'})});assert.equal(update.status,200);assert.equal(JSON.parse(await kv.get('c')).ena,'no');assert.equal(JSON.parse(await kv.get('c')).ispUnicom,'yes');
    const invalidWs=await mf.dispatchFetch('https://worker.example/',{headers:{Upgrade:'websocket'}});
    invalidWs.webSocket.accept();const rejected=message(invalidWs.webSocket);const bad=vless(port);bad[1]=255;invalidWs.webSocket.send(bad);await assert.rejects(rejected,/closed before echo/);
    for(const [kind,header,reply] of [['vless',vless(port),Buffer.from([0,0])],['trojan',trojan(port),Buffer.alloc(0)]]) {
      const response=await mf.dispatchFetch('https://worker.example/',{headers:{Upgrade:'websocket'}});assert.equal(response.status,101);
      const ws=response.webSocket;ws.accept();const pending=message(ws);const payload=Buffer.from('roundtrip-'+kind);
      ws.send(header.subarray(0,10));ws.send(Buffer.concat([header.subarray(10),payload]));
      assert.deepEqual(await pending,Buffer.concat([reply,payload]));
      const second=message(ws);ws.send(Buffer.from('second-frame'));assert.deepEqual(await second,Buffer.from('second-frame'));ws.close();
    }
    const earlyPayload=Buffer.from('early-data');
    const early=await mf.dispatchFetch('https://worker.example/',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':Buffer.concat([vless(port),earlyPayload]).toString('base64url')}});
    const earlyReply=message(early.webSocket);early.webSocket.accept();assert.deepEqual(await earlyReply,Buffer.concat([Buffer.from([0,0]),earlyPayload]));early.webSocket.close();
    for(const kind of ['socks5','http']) {
      const proxy=createServer(socket=>{
        sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));let state=0,buffer=Buffer.alloc(0);
        socket.on('data',data=>{
          if(state===2){socket.write(data);return;}buffer=Buffer.concat([buffer,data]);assert.ok(buffer.length<4096);
          if(kind==='http') {
            const end=buffer.indexOf('\r\n\r\n');if(end<0)return;
            assert.match(buffer.subarray(0,end).toString(),new RegExp('^CONNECT 127\\.0\\.0\\.1:'+port+' HTTP/1.1'));
            assert.match(buffer.subarray(0,end).toString(),new RegExp('Proxy-Authorization: Basic '+Buffer.from('test:password').toString('base64')));
            socket.write('HTTP/1.1 200 Connection established\r\n\r\n');buffer=buffer.subarray(end+4);state=2;
          } else {
            if(state===0){if(buffer.length<2+buffer[1])return;assert.equal(buffer[0],5);buffer=buffer.subarray(2+buffer[1]);socket.write(Buffer.from([5,0]));state=1;}
            if(state===1){if(buffer.length<10)return;assert.deepEqual([...buffer.subarray(0,4)],[5,1,0,1]);assert.equal(buffer.readUInt16BE(8),port);buffer=buffer.subarray(10);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));state=2;}
          }
          if(state===2&&buffer.length){socket.write(buffer);buffer=Buffer.alloc(0);}
        });
      });
      proxy.listen(0,'127.0.0.1');await once(proxy,'listening');proxies.push(proxy);
      const settings=await mf.dispatchFetch('https://worker.example/'+user+'/api/config',{method:'POST',body:JSON.stringify({s:kind+'://'+(kind==='http'?'test:password@':'')+'127.0.0.1:'+proxy.address().port,qj:'only'})});assert.equal(settings.status,200);
      const response=await mf.dispatchFetch('https://worker.example/',{headers:{Upgrade:'websocket'}});response.webSocket.accept();const reply=message(response.webSocket);response.webSocket.send(Buffer.concat([vless(port),Buffer.from(kind)]));assert.deepEqual(await reply,Buffer.concat([Buffer.from([0,0]),Buffer.from(kind)]));response.webSocket.close();
    }
    await mf.dispatchFetch('https://worker.example/'+user+'/api/config',{method:'POST',body:JSON.stringify({s:null,qj:null})});
    const payload=Buffer.from('xhttp-roundtrip');
    const xhttp=await mf.dispatchFetch('https://worker.example/'+user,{method:'POST',body:Buffer.concat([vless(port),payload])});
    assert.equal(xhttp.status,200);
    const reader=xhttp.body.getReader();let bytes=Buffer.alloc(0);
    while(bytes.length<payload.length+2){const part=await reader.read();assert.equal(part.done,false);bytes=Buffer.concat([bytes,Buffer.from(part.value)]);}
    assert.deepEqual(bytes,Buffer.concat([Buffer.from([0,0]),payload]));await reader.cancel();
  } finally { await mf.dispose();for(const socket of sockets)socket.destroy();await Promise.all([echo,...proxies].map(server=>new Promise(resolve=>server.close(resolve)))); }
});
