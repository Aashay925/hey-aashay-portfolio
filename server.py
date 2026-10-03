"""
High-performance local development server with full HTTP 206 Partial Content (Byte Range) support.
Essential for HTML5 video scrubbing and seeking.
"""
import os
import re
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

class RangeRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'public, max-age=3600')
        super().end_headers()

    def do_HEAD(self):
        range_header = self.headers.get('Range')
        if not range_header or '=' not in range_header:
            return super().do_HEAD()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_HEAD()

        file_size = os.path.getsize(path)
        range_match = re.match(r'bytes=(\d+)-(\d*)', range_header)
        if not range_match:
            return super().do_HEAD()

        start_str, end_str = range_match.groups()
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1

        content_length = end - start + 1
        content_type = self.guess_type(path)

        self.send_response(206, "Partial Content")
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.send_header('Content-Length', str(content_length))
        self.end_headers()

    def do_GET(self):
        range_header = self.headers.get('Range')
        if not range_header or '=' not in range_header:
            return super().do_GET()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()

        file_size = os.path.getsize(path)
        range_match = re.match(r'bytes=(\d+)-(\d*)', range_header)
        if not range_match:
            return super().do_GET()

        start_str, end_str = range_match.groups()
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1

        if start >= file_size or end >= file_size or start > end:
            self.send_error(416, "Requested Range Not Satisfiable")
            self.send_header('Content-Range', f'bytes */{file_size}')
            self.end_headers()
            return

        content_length = end - start + 1
        content_type = self.guess_type(path)

        self.send_response(206, "Partial Content")
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.send_header('Content-Length', str(content_length))
        self.end_headers()

        with open(path, 'rb') as f:
            f.seek(start)
            remaining = content_length
            chunk_size = 64 * 1024
            while remaining > 0:
                to_read = min(remaining, chunk_size)
                data = f.read(to_read)
                if not data:
                    break
                try:
                    self.wfile.write(data)
                except (ConnectionResetError, BrokenPipeError):
                    break
                remaining -= len(data)

def run():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = HTTPServer(('127.0.0.1', port), RangeRequestHandler)
    print(f"Range-enabled server running on http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == '__main__':
    run()
