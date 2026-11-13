#!/usr/bin/env python3
"""Serve only the install page, APK and checksum to the local Wi-Fi network."""
import argparse
import hashlib
import io
from pathlib import Path
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from monitor import lan_addresses
from companion_config import VERSION, apk_path

APK = apk_path()
PAGE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f5f5f7"><title>安装 Codex 副屏</title><style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(ellipse at 0 0,#dce9fa,transparent 70%),radial-gradient(ellipse at 100% 60%,#e8def7,transparent 70%),#f5f5f7;color:#1d1d1f;min-height:100dvh;padding:32px 20px}main{max-width:500px;margin:8vh auto;padding:28px;background:#ffffff80;border:1px solid #fff;border-radius:28px;box-shadow:0 20px 50px #30406312}small{color:#7b8495}h1{font-size:30px;letter-spacing:-1px;margin:24px 0 12px}p,li{font-size:14px;color:#687183;line-height:1.9}a.download{display:block;background:#007aff;color:#fff;border-radius:30px;text-align:center;padding:15px;text-decoration:none;margin:26px 0;font-weight:500}ol{padding-left:22px}img{display:block;width:180px;height:180px;padding:8px;background:#fff;border-radius:16px;margin:26px auto 12px}code{font-size:11px;overflow-wrap:anywhere;color:#8992a2}footer{margin-top:24px;font-size:12px;color:#8992a2}</style><main><small>ANDROID · CODEX COMPANION</small><h1>把进展，放在手边。</h1><p>安装 Codex 副屏，原生常亮、全屏显示，继续使用现在的玻璃风格页面。</p><a class="download" href="/codex-companion.apk" download>下载 Android 安装包</a><small>版本 1.3.0 · Android 8.0 及以上 · __SIZE__ KB</small><ol><li>下载后打开 APK，按手机提示允许此来源安装。</li><li>手机与电脑连接同一 Wi-Fi，电脑保持副屏服务运行。</li><li>在电脑页面点击「连接手机」，查看 6 位配对码。</li><li>打开 App，选择发现的电脑，输入 6 位码。配对页可授权显示当前 Wi-Fi 名称。</li></ol><img src="/qr.svg" alt="在手机上扫码打开本安装页" onerror="this.hidden=true"><p style="text-align:center">用安卓手机相机扫码打开</p><footer>配对后记住设备，服务重启无需重新配对。前台常亮；手机可审批和回复，输入框随键盘上移。<br>仅本地局域网下载，没有上传到外部平台。</footer><p><code>SHA-256: __SHA__</code></p></main></html>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        host = self.headers.get('Host', '').lower()
        if host not in self.server.allowed_hosts:
            self.send_error(403)
            return
        path = urlparse(self.path).path
        extra = None
        if path == '/':
            data = PAGE.replace('__SHA__', hashlib.sha256(APK.read_bytes()).hexdigest()).replace('__SIZE__', str(round(APK.stat().st_size / 1024))).encode()
            kind = 'text/html; charset=utf-8'
        elif path == '/codex-companion.apk':
            data = APK.read_bytes()
            kind = 'application/vnd.android.package-archive'
            extra = ('Content-Disposition', 'attachment; filename="codex-companion-1.3.0.apk"')
        elif path == '/qr.svg':
            try:
                import qrcode
                from qrcode.image.svg import SvgPathImage
                buffer = io.BytesIO()
                qrcode.make(self.server.install_url, image_factory=SvgPathImage, border=2).save(buffer)
                data, kind = buffer.getvalue(), 'image/svg+xml'
            except ImportError:
                self.send_error(404)
                return
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        if extra:
            self.send_header(*extra)
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description='在同一 Wi-Fi 分发 Codex 副屏 APK')
    parser.add_argument('--port', type=int, default=18378)
    args = parser.parse_args()
    if not APK.exists():
        raise SystemExit('请先运行 python3 scripts/build_apk.py')
    ips = lan_addresses()
    preferred = next((ip for ip in ips if ip.startswith('192.168.')), ips[0] if ips else '127.0.0.1')
    server = ThreadingHTTPServer(('0.0.0.0', args.port), Handler)
    server.daemon_threads = True
    server.allowed_hosts = {f'{ip}:{args.port}' for ip in ['127.0.0.1', 'localhost', *ips]}
    server.install_url = f'http://{preferred}:{args.port}/'
    print('手机安装页面：' + server.install_url, flush=True)
    print('电脑安装页面：' + f'http://127.0.0.1:{args.port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
