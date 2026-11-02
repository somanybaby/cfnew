"""Measure each subscribed transport's actual exit. No credentials are logged.

Requires: pip install websockets certifi h2
Input is a private Base64 subscription file; output is private measurement JSON.
Run this from the network whose observed exits should be labelled.
"""
import argparse
import asyncio
import base64
import hashlib
import json
import ssl
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote, urlsplit

import certifi
import h2.config
import h2.connection
import h2.events
from websockets.asyncio.client import connect


def node_key(node):
    parts = [node['protocol'], node['transport'], node['host'].lower(), str(node['port'])]
    if node.get('compat'):
        parts.append('compat')
    return '|'.join(parts)


def parse_subscription(text):
    lines = base64.b64decode(text).decode('utf-8').splitlines()
    nodes = {}
    for line in lines:
        url = urlsplit(line)
        if url.scheme not in ('vless', 'trojan'):
            continue
        query = parse_qs(url.query)
        node = dict(protocol=url.scheme, transport=query.get('type', ['ws'])[0],
                    host=url.hostname, port=url.port or 443, credential=unquote(url.username),
                    sni=query.get('sni', query.get('host', [url.hostname]))[0],
                    path=query.get('path', ['/?ed=2048'])[0])
        nodes[node_key(node)] = node
    for node in list(nodes.values()):
        if node['transport'] == 'xhttp':
            compat = dict(node, transport='ws', compat=True)
            nodes[node_key(compat)] = compat
    return list(nodes.values())


class H2Tunnel:
    def __init__(self, reader, writer, conn):
        self.reader, self.writer, self.conn = reader, writer, conn
        self.pending = []

    @classmethod
    async def open(cls, node):
        context = ssl.create_default_context(cafile=certifi.where())
        context.set_alpn_protocols(['h2'])
        reader, writer = await asyncio.open_connection(node['host'], node['port'],
                                                      ssl=context, server_hostname=node['sni'])
        conn = h2.connection.H2Connection(config=h2.config.H2Configuration(client_side=True))
        conn.initiate_connection()
        conn.send_headers(1, [(':method', 'POST'), (':scheme', 'https'),
                              (':authority', node['sni']), (':path', node['path']),
                              ('content-type', 'application/grpc')])
        writer.write(conn.data_to_send())
        await writer.drain()
        return cls(reader, writer, conn)

    async def send(self, data):
        self.conn.send_data(1, data)
        self.writer.write(self.conn.data_to_send())
        await self.writer.drain()

    async def recv(self):
        while not self.pending:
            data = await self.reader.read(65536)
            if not data:
                raise ConnectionError('XHTTP closed')
            for event in self.conn.receive_data(data):
                if isinstance(event, h2.events.ResponseReceived):
                    status = dict(event.headers).get(b':status', b'')
                    if status != b'200':
                        raise ConnectionError('XHTTP HTTP ' + status.decode())
                elif isinstance(event, h2.events.DataReceived):
                    self.conn.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                    if event.data:
                        self.pending.append(event.data)
                elif isinstance(event, (h2.events.StreamReset, h2.events.ConnectionTerminated)):
                    raise ConnectionError('XHTTP reset')
                elif isinstance(event, h2.events.StreamEnded) and not self.pending:
                    raise ConnectionError('XHTTP ended')
            self.writer.write(self.conn.data_to_send())
            await self.writer.drain()
        return self.pending.pop(0)

    async def close(self):
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except (ssl.SSLError, ConnectionError):
            pass


def decode_http(body):
    headers, payload = body.split(b'\r\n\r\n', 1)
    if b' 200 ' not in headers.split(b'\r\n', 1)[0]:
        raise ValueError('Geolocation HTTP status')
    if b'transfer-encoding: chunked' in headers.lower():
        result = b''
        while payload:
            length, payload = payload.split(b'\r\n', 1)
            length = int(length.split(b';')[0], 16)
            if length == 0:
                break
            result += payload[:length]
            payload = payload[length + 2:]
        payload = result
    return json.loads(payload)


async def probe(node):
    started = time.monotonic()
    target = b'ipwho.is'
    credential = node['credential']
    if node['protocol'] == 'trojan':
        header = (hashlib.sha224(credential.encode()).hexdigest().encode() + b'\r\n\x01\x03'
                  + bytes([len(target)]) + target + b'\x01\xbb\r\n')
    else:
        header = (b'\x00' + uuid.UUID(credential).bytes + b'\x00\x01\x01\xbb\x02'
                  + bytes([len(target)]) + target)
    tunnel = None
    async with asyncio.timeout(22):
        try:
            if node['transport'] == 'xhttp':
                tunnel = await H2Tunnel.open(node)
            elif node['transport'] == 'ws':
                # URI controls TLS SNI/Host. host= pins the subscribed entrance.
                tunnel = await connect('wss://' + node['sni'] + ':' + str(node['port']) + node['path'],
                                       host=node['host'], port=node['port'], proxy=None,
                                       ssl=ssl.create_default_context(cafile=certifi.where()), open_timeout=8)
            else:
                raise ValueError('Unsupported transport')
            await tunnel.send(header)
            incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
            tls = ssl.create_default_context(cafile=certifi.where()).wrap_bio(
                incoming, outgoing, server_hostname=target.decode())
            first = node['protocol'] == 'vless'
            response_header = b''

            async def flush():
                while outgoing.pending:
                    await tunnel.send(outgoing.read())

            async def receive():
                nonlocal first, response_header
                data = await tunnel.recv()
                if first:
                    response_header += data
                    if len(response_header) < 2 or len(response_header) < 2 + response_header[1]:
                        return
                    data = response_header[2 + response_header[1]:]
                    first = False
                if data:
                    incoming.write(data)

            while True:
                try:
                    tls.do_handshake()
                    await flush()
                    break
                except ssl.SSLWantReadError:
                    await flush()
                    await receive()
            tls.write(b'GET / HTTP/1.1\r\nHost: ipwho.is\r\nAccept: application/json\r\nConnection: close\r\n\r\n')
            await flush()
            response = b''
            while len(response) < 65536:
                try:
                    data = tls.read(65536)
                    if not data:
                        break
                    response += data
                    try:
                        result = decode_http(response)
                        if result.get('success') is False or not result.get('country_code'):
                            raise ValueError('Geolocation unavailable')
                        return dict(ip=result['ip'], countryCode=result['country_code'],
                                    city=result.get('city', ''), testedAt=datetime.now(timezone.utc).isoformat(),
                                    elapsedMs=round((time.monotonic() - started) * 1000), method=node['transport'])
                    except (json.JSONDecodeError, IndexError, ValueError) as exc:
                        if isinstance(exc, ValueError) and str(exc) == 'Geolocation unavailable':
                            raise
                except ssl.SSLWantReadError:
                    await flush()
                    await receive()
            raise ValueError('Incomplete geolocation response')
        finally:
            if tunnel is not None:
                await tunnel.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--subscription-file', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--concurrency', type=int, default=4)
    parser.add_argument('--compat-only', action='store_true', help='Only probe client WS-compatibility entries')
    args = parser.parse_args()
    from pathlib import Path
    nodes = parse_subscription(Path(args.subscription_file).read_text('utf-8'))
    if args.compat_only:
        nodes = [node for node in nodes if node.get('compat')]
    if args.limit:
        # Include each protocol in a small diagnostic sample.
        nodes.sort(key=lambda n: (n['host'], n['protocol'], n['transport']))
        nodes = nodes[:args.limit]
    results, failures = {}, {}
    sem = asyncio.Semaphore(args.concurrency)

    async def run(node):
        async with sem:
            key = node_key(node)
            try:
                results[key] = await probe(node)
                print(json.dumps(dict(done=len(results) + len(failures), total=len(nodes),
                                      protocol=node['protocol'], transport=node['transport'],
                                      country=results[key]['countryCode']), ensure_ascii=False), flush=True)
            except Exception as exc:
                failures[key] = type(exc).__name__
                print(json.dumps(dict(done=len(results) + len(failures), total=len(nodes),
                                      protocol=node['protocol'], transport=node['transport'],
                                      error=type(exc).__name__, detail=str(exc)[:100].replace(node['credential'], '[redacted]'))), flush=True)

    await asyncio.gather(*(run(node) for node in nodes))
    record = dict(version=1, measuredAt=datetime.now(timezone.utc).isoformat(),
                  source='ipwho.is via each subscribed transport; TLS verified',
                  nodes=results, failures=failures)
    Path(args.output).write_text(json.dumps(record, ensure_ascii=False, indent=2), 'utf-8')
    print(json.dumps(dict(passed=len(results), failed=len(failures))), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
