"""Inspect the user's local parking-assistant package without saving unpacked code.

Use the bundled Python runtime (cryptography required). Optional --probe only
calls the official read-only parkList method. DELIYUN_MINIAPP_TOKEN is optional;
without it, the request verifies the service's authentication requirement.
Passwords and local session storage are never read by this script.
"""
import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import string
import struct
import time
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def read_package(path, appid):
    data = path.read_bytes()
    source_hash = hashlib.sha256(data).hexdigest()
    if data.startswith(b'V1MMWX'):
        key = hashlib.pbkdf2_hmac('sha1', appid.encode(), b'saltiest', 1000, 32)
        decryptor = Cipher(algorithms.AES(key), modes.CBC(b'the iv: 16 bytes')).decryptor()
        prefix = decryptor.update(data[6:1030]) + decryptor.finalize()
        data = prefix[:1023] + bytes(value ^ ord(appid[-2]) for value in data[1030:])
    if len(data) < 18 or data[0] != 0xBE or data[13] != 0xED:
        raise ValueError('Unsupported package header')
    files = {}
    count = struct.unpack_from('>I', data, 14)[0]
    position = 18
    for _ in range(count):
        length = struct.unpack_from('>I', data, position)[0]
        position += 4
        name = data[position:position + length].decode()
        position += length
        offset, size = struct.unpack_from('>II', data, position)
        position += 8
        if offset + size > len(data):
            raise ValueError('Invalid package entry')
        files[name] = data[offset:offset + size]
    return files, source_hash


def module_body(source, name):
    marker = f'define("{name}",'
    start = source.index(marker)
    end = source.index('},{isPage:', start)
    return source[start:end]


def inspect(files, source_hash, appid):
    source = files['/appservice.app.js'].decode()
    api = module_body(source, 'public/API.js')
    header = module_body(source, 'public/requestHeader.js')
    secret_module = module_body(source, 'utils/secret.js')
    base = re.search(r'var \w+="(https://[^\"]+)"', api).group(1)
    endpoints = dict(re.findall(r'(\w+):\w+\+"([^\"]+)"', api))
    version = re.search(r'function \w+\(\)\{return"([^\"]+)"\}', header).group(1)
    if not re.search(r'ShaEncrypt:function\(\w+\)\{return \w+\.SHA256\(', secret_module):
        raise ValueError('Signing algorithm changed')
    match = re.search(r'\.Encrypt\(\w+,"([^\"]+)","([^\"]+)"\)', header)
    key, iv = match.group(1).encode(), match.group(2).encode()
    signing_secret = re.search(r'&secret=([^\"]+)"', header).group(1)
    if base != 'https://apis-pmas.deliyun.cn/apis/app/pmas' or version != '3.0':
        raise ValueError('Unexpected API host or version')
    result = {
        'appid': appid, 'sourceSha256': source_hash, 'fileCount': len(files),
        'baseUrl': base, 'apiVersion': version, 'endpoints': endpoints,
        'headers': ['ver', 'times', 'reqid', 'token', 'sign'],
        'body': 'data=<Base64(AES-CBC-PKCS7(JSON))>',
        'aesKeyBits': len(key) * 8, 'ivBytes': len(iv), 'signature': 'SHA256 hex',
        'signInput': 'ver=3.0&times=<Unix seconds>&reqid=<32 characters>&token=<session>&data=<encrypted body>&secret=<package constant>',
        'credentialSource': 'account login response; separate from OpenAPI AccessKey',
        'webviewHost': 'https://wpma.deliyun.cn',
        'sensitiveConstants': '[REDACTED]',
    }
    return result, key, iv, signing_secret


class MiniappReadClient:
    """Research client: login and an explicit allowlist of read-only queries.

    The H5 code sets the same session token in the pmatoken cookie. No write
    endpoints, token refresh, persisted cookies or credential logging are used.
    """
    APP_METHODS = {'/user/login', '/user/getMenus', '/punit/parkList', '/punit/findParkCount'}
    H5_METHODS = {
        '/pma/card/findParkCards', '/pma/card/findCard',
        '/pma/base/findParkGarageList', '/pma/base/findCardTypeList',
        '/pma/base/findCarTypeList', '/pma/base/findCardPayRuleList',
        '/pma/card/findCardGroupSelList', '/pma/card/findCardPoolParks',
    }

    def __init__(self, metadata, key, iv, signing_secret):
        self.metadata, self.key, self.iv, self.secret = metadata, key, iv, signing_secret
        self.token = ''
        self.cookies = http.cookiejar.CookieJar()
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(self.cookies))

    def app_read(self, method, payload):
        if method not in self.APP_METHODS:
            raise ValueError('Method is not allowed')
        plaintext = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
        padder = padding.PKCS7(128).padder()
        padded = padder.update(plaintext) + padder.finalize()
        encryptor = Cipher(algorithms.AES(self.key), modes.CBC(self.iv)).encryptor()
        data = base64.b64encode(encryptor.update(padded) + encryptor.finalize()).decode()
        times = str(int(time.time()))
        reqid = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))
        canonical = f'ver=3.0&times={times}&reqid={reqid}&token={self.token}&data={data}&secret={self.secret}'
        request = urllib.request.Request(
            self.metadata['baseUrl'] + method,
            data=urllib.parse.urlencode({'data': data}).encode(),
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'ver': '3.0',
                     'times': times, 'reqid': reqid, 'token': self.token,
                     'sign': hashlib.sha256(canonical.encode()).hexdigest()},
        )
        with self.opener.open(request, timeout=12) as response:
            return json.loads(response.read())

    def login(self, username, password):
        reqid = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))
        result = self.app_read('/user/login', {'username': username, 'password': password,
                                             'vcode': '', 'vcodeid': reqid})
        if str(result.get('ecode')) == '0':
            self.token = result.get('data', {}).get('token', '')
        return {'ecode': result.get('ecode'), 'sessionAvailable': bool(self.token)}

    def html(self, path, unit_key):
        if path not in {'/park/card', '/park/addcard'} or not self.token:
            raise ValueError('Page is not allowed or session is unavailable')
        query = urllib.parse.urlencode({'token': self.token, 'unitKey': unit_key})
        with self.opener.open('https://wpma.deliyun.cn' + path + '?' + query, timeout=12) as response:
            html = response.read().decode('utf-8')
        # Mirror getToken.js's browser cookie, retaining server-issued session
        # cookies from the authenticated page in memory as well.
        self.cookies.set_cookie(http.cookiejar.Cookie(
            0, 'pmatoken', self.token, None, False, 'wpma.deliyun.cn', True, False,
            '/', True, True, None, True, None, None, {}, False))
        return html

    def h5_read(self, method, payload):
        if method not in self.H5_METHODS or not self.token:
            raise ValueError('Method is not allowed or session is unavailable')
        query = urllib.parse.urlencode(payload, doseq=True)
        url = 'https://wpma.deliyun.cn/apis/park' + method
        if method == '/pma/card/findCard':
            # The official detail page uses POST for this read-only method.
            request = urllib.request.Request(url, data=query.encode(),
                                             headers={'Content-Type': 'application/x-www-form-urlencoded'})
        else:
            request = urllib.request.Request(url + '?' + query)
        with self.opener.open(request, timeout=12) as response:
            return json.loads(response.read())


def probe(metadata, key, iv, signing_secret):
    token = os.environ.get('DELIYUN_MINIAPP_TOKEN', '')
    plaintext = json.dumps({'pageNum': 1, 'name': '枫桦景苑'}, ensure_ascii=False, separators=(',', ':')).encode()
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    data = base64.b64encode(encryptor.update(padded) + encryptor.finalize()).decode()
    timestamp = str(int(time.time()))
    request_id = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))
    canonical = f'ver=3.0&times={timestamp}&reqid={request_id}&token={token}&data={data}&secret={signing_secret}'
    sign = hashlib.sha256(canonical.encode()).hexdigest()
    request = urllib.request.Request(
        metadata['baseUrl'] + '/punit/parkList',
        data=urllib.parse.urlencode({'data': data}).encode(),
        headers={'Content-Type': 'application/x-www-form-urlencoded', 'ver': '3.0',
                 'times': timestamp, 'reqid': request_id, 'token': token, 'sign': sign},
    )
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=12) as response:
        payload = json.loads(response.read())
        status = response.status
    message = str(payload.get('msg', ''))
    for value in [token, signing_secret, key.decode(), iv.decode(), sign]:
        if value:
            message = message.replace(value, '[REDACTED]')
    value = payload.get('data')
    summary = {'type': type(value).__name__}
    if isinstance(value, list):
        summary.update(count=len(value), fields=list(value[0]) if value and isinstance(value[0], dict) else [])
    elif isinstance(value, dict):
        summary['fields'] = list(value)
    return {'httpStatus': status, 'ecode': payload.get('ecode'), 'msg': message,
            'success': 200 <= status < 300 and str(payload.get('ecode')) == '0',
            'sessionProvided': bool(token), 'data': summary}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--appid', required=True)
    parser.add_argument('--probe', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'wx[0-9a-f]{16}', args.appid):
        parser.error('Invalid appid')
    files, source_hash = read_package(args.package, args.appid)
    metadata, key, iv, signing_secret = inspect(files, source_hash, args.appid)
    print(json.dumps(metadata, ensure_ascii=False))
    if args.probe:
        result = probe(metadata, key, iv, signing_secret)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result['success'] else 1
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        # Never echo exceptions that could embed requests, session values or constants.
        print('Analysis/probe failed; no credential values were printed.')
        raise SystemExit(1)
