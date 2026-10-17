"""Serve dist/skytreeone for testing the content script on bsky.app without
installing the extension: adds the CORS and Private Network Access headers
Chrome needs before a public page may load scripts from localhost.

    python tools/serve.py [port]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = Path(__file__).resolve().parent.parent / 'dist' / 'skytreeone'


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8174
ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, directory=str(DIST))).serve_forever()
