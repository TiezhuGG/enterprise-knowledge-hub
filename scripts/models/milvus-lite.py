"""Pinned Lite development runner; persistent DB and Unix gRPC socket, no HTTP bridge."""
import argparse,signal,threading
from milvus_lite.server import Server
p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--address',help='Optional loopback TCP address for tests');a=p.parse_args()
if a.address and not a.address.startswith('127.0.0.1:'):p.error('only loopback TCP is allowed')
server=Server(a.database,address=a.address)
if not server.init() or not server.start():raise RuntimeError('Milvus Lite startup failed')
print(a.address or server.uds_path,flush=True)
stop=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stop.set());signal.signal(signal.SIGINT,lambda *_:stop.set());stop.wait()
# Lite 2.4's TCP mode does not receive the lock path; explicitly stop our child.
child=server._p
server.stop()
if child is not None and child.poll() is None:
 child.terminate()
 try:child.wait(timeout=3)
 except __import__('subprocess').TimeoutExpired:child.kill();child.wait()
