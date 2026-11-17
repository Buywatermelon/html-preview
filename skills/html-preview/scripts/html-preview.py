#!/usr/bin/env python3
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

DEFAULT_URL = 'https://html.1997117.xyz'
MAX_BYTES = 20 * 1024 * 1024
CROCKFORD_B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
LAUNCHD_LABEL = 'dev.html-preview.daemon'
SYSTEMD_UNIT = 'html-preview-daemon.service'
_credential_context = None
_held_lifecycle_locks = set()


def config():
    for parent in (Path.cwd(), *Path.cwd().parents):
        path = parent / '.html-preview.json'
        if path.is_file():
            value = json.loads(path.read_text())
            if not isinstance(value, dict):
                raise ValueError(f'{path} must contain a JSON object')
            return path, value
    return Path.cwd() / '.html-preview.json', {}


def save_config(path, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _open_json(base, path, method='GET', payload=None, content_type='application/json', auth=True):
    headers = {'Accept': 'application/json', 'User-Agent': 'html-preview-cli/1.1'}
    if auth:
        token = token_for(base)
        if '\n' in token or '\r' in token:
            raise ValueError('HTML_PREVIEW_TOKEN cannot contain line breaks')
        if token:
            headers['Authorization'] = 'Bearer ' + token
    if payload is not None:
        headers['Content-Type'] = content_type
        if isinstance(payload, dict):
            payload = json.dumps(payload, ensure_ascii=False).encode()
    req = urllib.request.Request(base.rstrip('/') + path, data=payload, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=180, context=ssl.create_default_context()) as response:
        return json.load(response)


def request(base, path, method='GET', payload=None, content_type='application/json', auth=True):
    try:
        return _open_json(base, path, method, payload, content_type, auth=auth)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            error.close()
            raise ValueError('Sign in with: html-preview login <URL> (or set HTML_PREVIEW_TOKEN)') from None
        try:
            detail = json.load(error).get('error', error.reason)
        except (ValueError, AttributeError, TypeError):
            detail = error.reason
        error.close()
        raise ValueError(f'HTTP {error.code}: {detail}') from None
    except urllib.error.URLError:
        raise ValueError('Cannot connect to html-preview; check the URL and network.') from None


def prepare(source):
    path = Path(source)
    if path.is_symlink() or not path.exists():
        raise ValueError('Use an existing regular file or directory; symlinks are refused')
    if path.is_dir():
        if not (path / 'index.html').is_file() or (path / 'index.html').is_symlink():
            raise ValueError('The directory must contain index.html')
        excluded = {'.git', 'node_modules', '.wrangler', '.DS_Store', '__MACOSX', '.venv', '__pycache__', '.html-preview.json'}
        def skip(name):
            return name in excluded or name.startswith(('.env', '.dev.vars', '._'))
        with tempfile.TemporaryFile() as stream:
            count, total = 0, 0
            with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                for root, dirs, files in os.walk(path, followlinks=False):
                    dirs[:] = sorted(name for name in dirs if not skip(name))
                    if any((Path(root) / name).is_symlink() for name in dirs):
                        raise ValueError('Symlink directories are refused')
                    for name in sorted(files):
                        if skip(name):
                            continue
                        file = Path(root) / name
                        if file.is_symlink() or not file.is_file():
                            raise ValueError('Only regular files are supported')
                        count += 1
                        total += file.stat().st_size
                        if count > 500 or total > MAX_BYTES:
                            raise ValueError('Directory exceeds 500 files or 20 MiB')
                        archive.write(file, file.relative_to(path).as_posix())
            if stream.tell() > MAX_BYTES:
                raise ValueError('ZIP exceeds 20 MiB')
            stream.seek(0)
            return stream.read(), 'application/zip'
    if not path.is_file() or path.suffix.lower() not in {'.html', '.htm', '.zip'}:
        raise ValueError('Expected an HTML file, ZIP, or directory containing index.html')
    if path.stat().st_size > MAX_BYTES:
        raise ValueError('File exceeds 20 MiB')
    return path.read_bytes(), 'application/zip' if path.suffix.lower() == '.zip' else 'text/html'


def output(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


class PageTitle(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'title':
            self.active = True

    def handle_endtag(self, tag):
        if tag == 'title':
            self.active = False

    def handle_data(self, data):
        if self.active:
            self.parts.append(data)


def daemon_paths():
    home = Path(os.environ.get('HOME') or str(Path.home()))
    default_cfg_base = home / '.config'
    default_state_base = home / '.local' / 'state'
    default_data_base = home / '.local' / 'share'
    xdg_cfg = os.environ.get('XDG_CONFIG_HOME')
    xdg_state = os.environ.get('XDG_STATE_HOME')
    xdg_data = os.environ.get('XDG_DATA_HOME')
    sock_env = (os.environ.get('HTML_PREVIEW_DAEMON_SOCK') or '').strip()
    cfg_base = Path(xdg_cfg) if xdg_cfg else default_cfg_base

    # When XDG_CONFIG_HOME is explicitly isolated (e.g. test sandboxes) without XDG_STATE_HOME/XDG_DATA_HOME,
    # keep state & data inside that isolated root so tests never touch user ~/.local.
    isolated_only_cfg = bool(xdg_cfg and Path(xdg_cfg).resolve() != default_cfg_base.resolve())
    isolated_cfg = bool(
        isolated_only_cfg
        or sock_env
        or (xdg_state and Path(xdg_state).resolve() != default_state_base.resolve())
        or (xdg_data and Path(xdg_data).resolve() != default_data_base.resolve())
    )
    state_base = (
        Path(xdg_state)
        if xdg_state
        else (cfg_base / '.local-state' if isolated_only_cfg else default_state_base)
    )
    data_base = (
        Path(xdg_data)
        if xdg_data
        else (cfg_base / '.local-share' if isolated_only_cfg else default_data_base)
    )

    config_dir = cfg_base / 'html-preview'
    state_dir = state_base / 'html-preview'
    data_dir = data_base / 'html-preview'

    if sock_env:
        socket_path = Path(sock_env)
    else:
        candidate = state_dir / 'daemon.sock'
        if len(str(candidate).encode('utf-8')) > 92:
            if isolated_cfg:
                digest = hashlib.sha256(str(state_dir).encode('utf-8')).hexdigest()[:10]
                socket_path = Path('/tmp') / f'hp-{digest}' / 'd.sock'
            else:
                uid = os.getuid() if hasattr(os, 'getuid') else 'u'
                socket_path = Path('/tmp') / f'hp-{uid}' / 'd.sock'
        else:
            socket_path = candidate

    if sys.platform == 'darwin' and not xdg_state and not isolated_only_cfg:
        log_file = home / 'Library' / 'Logs' / 'html-preview' / 'daemon.log'
    else:
        log_file = state_dir / 'logs' / 'daemon.log'

    return {
        'home': home,
        'isolated_cfg': isolated_cfg,
        'config_dir': config_dir,
        'state_dir': state_dir,
        'data_dir': data_dir,
        'host_file': config_dir / 'host.json',
        'credentials_file': config_dir / 'credentials.json',
        'socket_path': socket_path,
        'pid_file': state_dir / 'daemon.pid',
        'bundle_file': data_dir / 'daemon.mjs',
        'runner_script': data_dir / 'run-daemon.sh',
        'log_file': log_file,
    }


def credential_path():
    return daemon_paths()['credentials_file']


def credentials():
    path = credential_path()
    return json.loads(path.read_text()) if path.is_file() else {}


def _cred_entry(saved, base):
    if not isinstance(saved, dict):
        return {}
    servers = saved.get('servers')
    if isinstance(servers, dict) and isinstance(servers.get(base), dict):
        return servers[base]
    entry = saved.get(base)
    return entry if isinstance(entry, dict) else {}


def token_for(base):
    if _credential_context and _credential_context[0] == base:
        token = _credential_context[1]
    else:
        env_token = os.environ.get('HTML_PREVIEW_TOKEN')
        if env_token:
            if '\n' in env_token or '\r' in env_token:
                raise ValueError('HTML_PREVIEW_TOKEN cannot contain line breaks')
            return env_token
        token = _cred_entry(credentials(), base).get('token', '')
    if '\n' in token or '\r' in token:
        raise ValueError('HTML_PREVIEW_TOKEN cannot contain line breaks')
    return token


def _atomic_write_secure_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def save_credentials(saved):
    _atomic_write_secure_json(credential_path(), saved)


def _default_host_name():
    if sys.platform == 'darwin':
        try:
            proc = subprocess.run(
                ['scutil', '--get', 'ComputerName'],
                capture_output=True,
                text=True,
                timeout=1.2,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout.strip()[:80]
        except OSError:
            pass
    try:
        raw = (socket.gethostname() or '').strip()
    except OSError:
        raw = ''
    if raw.endswith('.local'):
        raw = raw[:-6]
    short = raw.split('.')[0] if raw else ''
    return (short or 'local-host')[:80]


def ensure_host_identity(preferred_name=None):
    paths = daemon_paths()
    host_file = paths['host_file']
    clean_preferred = (preferred_name or '').strip()[:80] or None

    if host_file.is_file():
        try:
            parsed = json.loads(host_file.read_text(encoding='utf-8'))
            host_id = parsed.get('hostId')
            host_name = (parsed.get('hostName') or '').strip()
            if isinstance(host_id, str) and re.fullmatch(r'hst_[A-Za-z0-9_-]{4,64}', host_id) and host_name:
                if clean_preferred and clean_preferred != host_name:
                    parsed['hostName'] = clean_preferred
                    _atomic_write_secure_json(host_file, parsed)
                return parsed
        except (ValueError, OSError):
            pass

    rand_bytes = secrets.token_bytes(20)
    suffix = ''.join(CROCKFORD_B32[b & 31] for b in rand_bytes)
    identity = {
        'hostId': f'hst_{suffix}',
        'hostName': clean_preferred or _default_host_name(),
        'platform': sys.platform,
        'arch': os.uname().machine if hasattr(os, 'uname') else 'unknown',
        'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    _atomic_write_secure_json(host_file, identity)
    return identity


def _unix_socket_json(sock_path, method, path, payload=None, timeout=0.25):
    sock_str = str(sock_path)
    if not os.path.exists(sock_str):
        return None
    body_bytes = b''
    headers = ['Host: localhost', 'Connection: close', 'Accept: application/json']
    if payload is not None:
        body_bytes = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        headers.append('Content-Type: application/json')
        headers.append(f'Content-Length: {len(body_bytes)}')
    head = f'{method} {path} HTTP/1.0\r\n' + '\r\n'.join(headers) + '\r\n\r\n'

    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(sock_str)
        client.sendall(head.encode('utf-8') + body_bytes)
        chunks = []
        while True:
            data = client.recv(8192)
            if not data:
                break
            chunks.append(data)
        raw = b''.join(chunks)
        if b'\r\n\r\n' not in raw:
            return None
        status_block, resp_body = raw.split(b'\r\n\r\n', 1)
        status_line = status_block.split(b'\r\n', 1)[0].decode('utf-8', errors='replace')
        parts = status_line.split(' ', 2)
        status_code = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
        parsed_body = json.loads(resp_body.decode('utf-8')) if resp_body.strip() else {}
        return status_code, parsed_body
    except (OSError, ValueError):
        return None
    finally:
        try:
            client.close()
        except OSError:
            pass


def probe_daemon_health(timeout=1.5, full=False):
    paths = daemon_paths()
    endpoint = '/v1/health?full=1' if full else '/v1/health'
    res = _unix_socket_json(paths['socket_path'], 'GET', endpoint, timeout=timeout)
    if res and res[0] == 200 and isinstance(res[1], dict) and res[1].get('ok') is True:
        return res[1]
    return None


@contextmanager
def _cli_lifecycle_lock(paths):
    state_dir = paths['state_dir']
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        state_dir.chmod(0o700)
    except OSError:
        pass
    lock_path = str((state_dir / 'cli-lifecycle.flock').resolve())
    if lock_path in _held_lifecycle_locks:
        yield
        return
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_CLOEXEC', 0)
    fd = os.open(lock_path, flags, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    _held_lifecycle_locks.add(lock_path)
    try:
        yield
    finally:
        _held_lifecycle_locks.discard(lock_path)
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


def _locate_source_daemon_bundle():
    env_override = (os.environ.get('HTML_PREVIEW_DAEMON_BUNDLE') or '').strip()
    if env_override:
        override_path = Path(env_override)
        return override_path if override_path.is_file() else None
    script_path = Path(__file__).resolve()
    candidates = []
    if len(script_path.parents) > 3:
        repo_root = script_path.parents[3]
        if (repo_root / 'src' / 'daemon').is_dir():
            candidates.append(repo_root / 'dist' / 'daemon.mjs')
    candidates.extend([
        script_path.parent / 'daemon.mjs',
        daemon_paths()['bundle_file'],
        Path('/workspace/html-preview/dist/daemon.mjs'),
    ])
    for cand in candidates:
        if cand.is_file():
            return cand
    return None


def _capture_enriched_path():
    home = str(daemon_paths()['home'])
    current = os.environ.get('PATH') or '/usr/bin:/bin'
    preferred = [
        f'{home}/.local/bin',
        '/opt/homebrew/bin',
        '/usr/local/bin',
    ]
    node_bin = shutil.which('node')
    if node_bin:
        preferred.insert(0, str(Path(node_bin).resolve().parent))
    merged = []
    for entry in [*preferred, *current.split(os.pathsep)]:
        entry = entry.strip()
        if entry and entry not in merged:
            merged.append(entry)
    return os.pathsep.join(merged)


def _atomic_write_bytes(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp')
    try:
        tmp.write_bytes(data)
        tmp.chmod(mode)
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def _install_daemon_bundle_and_runner():
    paths = daemon_paths()
    src_bundle = _locate_source_daemon_bundle()
    if not src_bundle:
        raise ValueError('Daemon bundle daemon.mjs not found; run npm run build:skill (or npm run build:daemon) first')
    enriched_path = _capture_enriched_path()
    node_bin = shutil.which('node') or shutil.which('node', path=enriched_path)
    if not node_bin:
        raise ValueError('Node.js (>=24) is required to run html-preview daemon')

    paths['data_dir'].mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        paths['data_dir'].chmod(0o700)
    except OSError:
        pass

    dest_bundle = paths['bundle_file']
    bundle_changed = False
    if src_bundle.resolve() != dest_bundle.resolve():
        src_bytes = src_bundle.read_bytes()
        existing_bytes = dest_bundle.read_bytes() if dest_bundle.is_file() else None
        if existing_bytes != src_bytes:
            _atomic_write_bytes(dest_bundle, src_bytes, 0o644)
            bundle_changed = True

    src_resolved = src_bundle.resolve()
    node_modules_dir = None
    for parent in src_resolved.parents:
        cand_nm = parent / 'node_modules'
        if (parent / 'src' / 'daemon').is_dir() and cand_nm.is_dir():
            node_modules_dir = cand_nm
            break

    node_modules_line = (
        f'export HTML_PREVIEW_NODE_MODULES="{node_modules_dir}"\n'
        if node_modules_dir is not None
        else ''
    )
    runner = paths['runner_script']
    runner_bytes = (
        '#!/bin/sh\n'
        f'export PATH="{enriched_path}"\n'
        f'{node_modules_line}'
        f'exec "{node_bin}" "{dest_bundle}" "$@"\n'
    ).encode('utf-8')
    if not runner.is_file() or runner.read_bytes() != runner_bytes:
        _atomic_write_bytes(runner, runner_bytes, 0o700)
    return node_bin, dest_bundle, enriched_path, node_modules_dir, bundle_changed


def _daemon_serve_args(paths, if_not_running=False):
    args = [
        'serve',
        '--config-dir',
        str(paths['config_dir']),
        '--state-dir',
        str(paths['state_dir']),
        '--socket',
        str(paths['socket_path']),
        '--log-file',
        str(paths['log_file']),
    ]
    if if_not_running:
        args.append('--if-not-running')
    return args


def _launchd_plist_path(paths=None):
    p = paths or daemon_paths()
    return p['home'] / 'Library' / 'LaunchAgents' / f'{LAUNCHD_LABEL}.plist'


def _systemd_unit_path(paths=None):
    p = paths or daemon_paths()
    return p['home'] / '.config' / 'systemd' / 'user' / SYSTEMD_UNIT


def _launchd_gui_available(paths=None):
    p = paths or daemon_paths()
    if sys.platform != 'darwin' or p.get('isolated_cfg'):
        return False
    if not shutil.which('launchctl'):
        return False
    uid = os.getuid() if hasattr(os, 'getuid') else 0
    try:
        proc = subprocess.run(
            ['launchctl', 'print', f'gui/{uid}'],
            capture_output=True,
            timeout=1.5,
            check=False,
        )
        return proc.returncode == 0
    except OSError:
        return False


def _launchd_is_loaded(uid):
    try:
        proc = subprocess.run(
            ['launchctl', 'print', f'gui/{uid}/{LAUNCHD_LABEL}'],
            capture_output=True,
            timeout=1.5,
            check=False,
        )
        return proc.returncode == 0
    except OSError:
        return False


def _systemd_user_available(paths=None):
    p = paths or daemon_paths()
    if sys.platform != 'linux' or p.get('isolated_cfg'):
        return False
    if not shutil.which('systemctl'):
        return False
    try:
        proc = subprocess.run(
            ['systemctl', '--user', 'show-environment'],
            capture_output=True,
            timeout=1.5,
            check=False,
        )
        return proc.returncode == 0
    except OSError:
        return False


def _installed_service_manager(paths=None):
    p = paths or daemon_paths()
    if _launchd_gui_available(p) and _launchd_plist_path(p).is_file():
        return 'launchd'
    if _systemd_user_available(p) and _systemd_unit_path(p).is_file():
        return 'systemd-user'
    return None


def _reload_daemon_or_health(paths, fallback_health):
    reload_res = _unix_socket_json(paths['socket_path'], 'POST', '/v1/reload', {}, timeout=2.5)
    if reload_res and reload_res[0] == 200 and isinstance(reload_res[1].get('health'), dict):
        return reload_res[1]['health']
    return fallback_health


def _wait_for_daemon_ready(paths, timeout=8.0, spawned_proc=None, avoid_pid=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        health = probe_daemon_health(timeout=1.5)
        if health and (avoid_pid is None or health.get('pid') != avoid_pid):
            if spawned_proc is not None and spawned_proc.poll() is None:
                spawned_proc._child_created = False
            return health
        if spawned_proc is not None:
            rc = spawned_proc.poll()
            if rc is not None and rc != 0:
                late_health = probe_daemon_health(timeout=1.0)
                if late_health:
                    return late_health
                raise ValueError(
                    f'Daemon exited with code {rc}; check logs at {paths["log_file"]}'
                )
        time.sleep(0.1)
    if spawned_proc is not None and spawned_proc.poll() is None:
        spawned_proc._child_created = False
    raise ValueError(f'Daemon failed to start within {timeout:g}s; check logs at {paths["log_file"]}')


def _shutdown_socket_daemon(paths, timeout=6.0):
    health = probe_daemon_health(timeout=1.0)
    if not health:
        return False, None
    pid = health.get('pid')
    _unix_socket_json(paths['socket_path'], 'POST', '/v1/shutdown', {}, timeout=2.0)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if probe_daemon_health(timeout=0.3) is None:
            return True, pid
        time.sleep(0.1)
    return True, pid


def _spawn_unmanaged_daemon(paths, node_bin, dest_bundle, enriched_path, node_modules_dir):
    paths['state_dir'].mkdir(parents=True, exist_ok=True, mode=0o700)
    paths['socket_path'].parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    paths['log_file'].parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    child_env = dict(os.environ)
    child_env['PATH'] = enriched_path
    if node_modules_dir is not None:
        child_env['HTML_PREVIEW_NODE_MODULES'] = str(node_modules_dir)
    cmd = [node_bin, str(dest_bundle), *_daemon_serve_args(paths, if_not_running=True)]

    with open(os.devnull, 'rb') as devnull_in, open(paths['log_file'], 'ab') as log_out:
        return subprocess.Popen(
            cmd,
            stdin=devnull_in,
            stdout=log_out,
            stderr=log_out,
            env=child_env,
            start_new_session=True,
            close_fds=True,
        )


def start_daemon_process(preferred_name=None):
    paths = daemon_paths()
    with _cli_lifecycle_lock(paths):
        ensure_host_identity(preferred_name=preferred_name)
        live = probe_daemon_health(timeout=1.5)
        if live:
            return _reload_daemon_or_health(paths, live)

        node_bin, dest_bundle, enriched_path, node_modules_dir, _changed = _install_daemon_bundle_and_runner()
        paths['state_dir'].mkdir(parents=True, exist_ok=True, mode=0o700)
        paths['socket_path'].parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        paths['log_file'].parent.mkdir(parents=True, exist_ok=True, mode=0o700)

        manager = _installed_service_manager(paths)
        if manager == 'launchd':
            uid = os.getuid() if hasattr(os, 'getuid') else 0
            plist_path = _launchd_plist_path(paths)
            if not _launchd_is_loaded(uid):
                boot = subprocess.run(
                    ['launchctl', 'bootstrap', f'gui/{uid}', str(plist_path)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if boot.returncode != 0 and not _launchd_is_loaded(uid):
                    detail = (boot.stderr or boot.stdout or '').strip()
                    raise ValueError(f'launchctl bootstrap failed: {detail or boot.returncode}')
            subprocess.run(
                ['launchctl', 'kickstart', f'gui/{uid}/{LAUNCHD_LABEL}'],
                capture_output=True,
                check=False,
            )
            return _wait_for_daemon_ready(paths)

        if manager == 'systemd-user':
            started = subprocess.run(
                ['systemctl', '--user', 'start', SYSTEMD_UNIT],
                capture_output=True,
                text=True,
                check=False,
            )
            if started.returncode != 0:
                detail = (started.stderr or started.stdout or '').strip()
                raise ValueError(f'systemctl --user start failed: {detail or started.returncode}')
            return _wait_for_daemon_ready(paths)

        proc = _spawn_unmanaged_daemon(paths, node_bin, dest_bundle, enriched_path, node_modules_dir)
        return _wait_for_daemon_ready(paths, spawned_proc=proc)


def stop_daemon_process():
    paths = daemon_paths()
    with _cli_lifecycle_lock(paths):
        manager = _installed_service_manager(paths)
        health = probe_daemon_health(timeout=1.5)
        if manager == 'systemd-user':
            subprocess.run(
                ['systemctl', '--user', 'stop', SYSTEMD_UNIT],
                capture_output=True,
                check=False,
            )
            if not health:
                return {'ok': True, 'stopped': False, 'reason': 'not_running'}
            pid = health.get('pid')
            deadline = time.monotonic() + 6.0
            while time.monotonic() < deadline:
                if probe_daemon_health(timeout=0.3) is None:
                    return {'ok': True, 'stopped': True, 'pid': pid}
                time.sleep(0.1)
            _shutdown_socket_daemon(paths, timeout=2.0)
            return {'ok': True, 'stopped': True, 'pid': pid}

        stopped, pid = _shutdown_socket_daemon(paths, timeout=6.0)
        if not stopped:
            return {'ok': True, 'stopped': False, 'reason': 'not_running'}
        return {'ok': True, 'stopped': True, 'pid': pid}


def restart_daemon_process(preferred_name=None):
    paths = daemon_paths()
    with _cli_lifecycle_lock(paths):
        ensure_host_identity(preferred_name=preferred_name)
        _install_daemon_bundle_and_runner()
        paths['state_dir'].mkdir(parents=True, exist_ok=True, mode=0o700)
        paths['socket_path'].parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        paths['log_file'].parent.mkdir(parents=True, exist_ok=True, mode=0o700)

        old_health = probe_daemon_health(timeout=1.0)
        old_pid = old_health.get('pid') if old_health else None
        manager = _installed_service_manager(paths)

        if manager == 'launchd':
            uid = os.getuid() if hasattr(os, 'getuid') else 0
            plist_path = _launchd_plist_path(paths)
            if not _launchd_is_loaded(uid):
                boot = subprocess.run(
                    ['launchctl', 'bootstrap', f'gui/{uid}', str(plist_path)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if boot.returncode != 0 and not _launchd_is_loaded(uid):
                    detail = (boot.stderr or boot.stdout or '').strip()
                    raise ValueError(f'launchctl bootstrap failed: {detail or boot.returncode}')
            subprocess.run(
                ['launchctl', 'kickstart', '-k', f'gui/{uid}/{LAUNCHD_LABEL}'],
                capture_output=True,
                check=False,
            )
            return _wait_for_daemon_ready(paths, avoid_pid=old_pid)

        if manager == 'systemd-user':
            restarted = subprocess.run(
                ['systemctl', '--user', 'restart', SYSTEMD_UNIT],
                capture_output=True,
                text=True,
                check=False,
            )
            if restarted.returncode != 0:
                detail = (restarted.stderr or restarted.stdout or '').strip()
                raise ValueError(f'systemctl --user restart failed: {detail or restarted.returncode}')
            return _wait_for_daemon_ready(paths, avoid_pid=old_pid)

        stop_daemon_process()
        return start_daemon_process(preferred_name=preferred_name)


def install_daemon_service(preferred_name=None):
    paths = daemon_paths()
    with _cli_lifecycle_lock(paths):
        identity = ensure_host_identity(preferred_name=preferred_name)
        node_bin, dest_bundle, enriched_path, node_modules_dir, bundle_changed = _install_daemon_bundle_and_runner()
        paths['state_dir'].mkdir(parents=True, exist_ok=True, mode=0o700)
        paths['socket_path'].parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        paths['log_file'].parent.mkdir(parents=True, exist_ok=True, mode=0o700)

        autostart_mode = 'background-supervisor'
        linger_hint = None

        if _launchd_gui_available(paths):
            autostart_mode = 'launchd'
            plist_path = _launchd_plist_path(paths)
            plist_path.parent.mkdir(parents=True, exist_ok=True)
            env_vars = {'PATH': enriched_path}
            if node_modules_dir is not None:
                env_vars['HTML_PREVIEW_NODE_MODULES'] = str(node_modules_dir)
            plist_data = {
                'Label': LAUNCHD_LABEL,
                'ProgramArguments': [node_bin, str(dest_bundle), *_daemon_serve_args(paths)],
                'RunAtLoad': True,
                'KeepAlive': {'SuccessfulExit': False},
                'ThrottleInterval': 5,
                'ProcessType': 'Background',
                'EnvironmentVariables': env_vars,
                'StandardOutPath': str(paths['log_file']),
                'StandardErrorPath': str(paths['log_file']),
            }
            plist_bytes = plistlib.dumps(plist_data)
            plist_changed = not plist_path.is_file() or plist_path.read_bytes() != plist_bytes
            if plist_changed:
                _atomic_write_bytes(plist_path, plist_bytes, 0o644)

            uid = os.getuid() if hasattr(os, 'getuid') else 0
            loaded = _launchd_is_loaded(uid)
            live = probe_daemon_health(timeout=1.5)

            if loaded and not plist_changed and not bundle_changed and live:
                health = _reload_daemon_or_health(paths, live)
            elif loaded and not plist_changed and not bundle_changed:
                subprocess.run(
                    ['launchctl', 'kickstart', f'gui/{uid}/{LAUNCHD_LABEL}'],
                    capture_output=True,
                    check=False,
                )
                health = _wait_for_daemon_ready(paths)
            else:
                if loaded:
                    subprocess.run(
                        ['launchctl', 'bootout', f'gui/{uid}', str(plist_path)],
                        capture_output=True,
                        check=False,
                    )
                    unload_deadline = time.monotonic() + 2.5
                    while time.monotonic() < unload_deadline:
                        if not _launchd_is_loaded(uid) and probe_daemon_health(timeout=0.3) is None:
                            break
                        time.sleep(0.08)
                # Stop any leftover unmanaged process holding the socket before launchd takes ownership
                _shutdown_socket_daemon(paths, timeout=3.0)
                boot = subprocess.run(
                    ['launchctl', 'bootstrap', f'gui/{uid}', str(plist_path)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if boot.returncode != 0 and not _launchd_is_loaded(uid):
                    detail = (boot.stderr or boot.stdout or '').strip()
                    raise ValueError(f'launchctl bootstrap failed: {detail or boot.returncode}')
                subprocess.run(
                    ['launchctl', 'kickstart', f'gui/{uid}/{LAUNCHD_LABEL}'],
                    capture_output=True,
                    check=False,
                )
                health = _wait_for_daemon_ready(paths)

        elif _systemd_user_available(paths):
            autostart_mode = 'systemd-user'
            unit_path = _systemd_unit_path(paths)
            unit_path.parent.mkdir(parents=True, exist_ok=True)
            exec_args = ' '.join(
                f'"{arg}"' for arg in [str(paths['runner_script']), *_daemon_serve_args(paths)]
            )
            unit_text = (
                '[Unit]\n'
                'Description=html-preview Local Agent Daemon\n'
                'After=network-online.target\n'
                'Wants=network-online.target\n\n'
                '[Service]\n'
                'Type=simple\n'
                f'ExecStart={exec_args}\n'
                'Restart=on-failure\n'
                'RestartSec=3\n'
                f'Environment="PATH={enriched_path}"\n\n'
                '[Install]\n'
                'WantedBy=default.target\n'
            )
            unit_bytes = unit_text.encode('utf-8')
            unit_changed = not unit_path.is_file() or unit_path.read_bytes() != unit_bytes
            if unit_changed:
                _atomic_write_bytes(unit_path, unit_bytes, 0o644)
                subprocess.run(['systemctl', '--user', 'daemon-reload'], capture_output=True, check=False)

            active_proc = subprocess.run(
                ['systemctl', '--user', 'is-active', '--quiet', SYSTEMD_UNIT],
                capture_output=True,
                check=False,
            )
            is_active = active_proc.returncode == 0
            live = probe_daemon_health(timeout=1.5)

            if is_active and not unit_changed and not bundle_changed and live:
                subprocess.run(['systemctl', '--user', 'enable', SYSTEMD_UNIT], capture_output=True, check=False)
                health = _reload_daemon_or_health(paths, live)
            elif is_active:
                subprocess.run(['systemctl', '--user', 'enable', SYSTEMD_UNIT], capture_output=True, check=False)
                restarted = subprocess.run(
                    ['systemctl', '--user', 'restart', SYSTEMD_UNIT],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if restarted.returncode != 0:
                    detail = (restarted.stderr or restarted.stdout or '').strip()
                    raise ValueError(f'systemctl --user restart failed: {detail or restarted.returncode}')
                health = _wait_for_daemon_ready(paths, avoid_pid=live.get('pid') if live else None)
            else:
                # Stop any leftover unmanaged process holding the socket before systemd takes ownership
                _shutdown_socket_daemon(paths, timeout=3.0)
                enabled = subprocess.run(
                    ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if enabled.returncode != 0:
                    detail = (enabled.stderr or enabled.stdout or '').strip()
                    raise ValueError(f'systemctl --user enable --now failed: {detail or enabled.returncode}')
                health = _wait_for_daemon_ready(paths)

            if shutil.which('loginctl') and os.environ.get('SSH_CONNECTION'):
                linger = subprocess.run(
                    ['loginctl', 'show-user', os.environ.get('USER', ''), '-p', 'Linger'],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if 'Linger=no' in (linger.stdout or ''):
                    linger_hint = f'sudo loginctl enable-linger {os.environ.get("USER", "$USER")}'
        else:
            autostart_dir = Path('/workspace/autostart/services.d')
            script_resolved = Path(__file__).resolve()
            src_autostart = (
                script_resolved.parents[3] / 'scripts' / '30-html-preview-daemon.sh'
                if len(script_resolved.parents) > 3
                else None
            )
            if (
                not paths['isolated_cfg']
                and src_autostart is not None
                and src_autostart.is_file()
                and autostart_dir.is_dir()
                and os.access(autostart_dir, os.W_OK)
            ):
                target_autostart = autostart_dir / '30-html-preview-daemon.sh'
                _atomic_write_bytes(target_autostart, src_autostart.read_bytes(), 0o755)
                autostart_mode = 'container-autostart'

            live = probe_daemon_health(timeout=1.5)
            if live and not bundle_changed:
                health = _reload_daemon_or_health(paths, live)
            elif live and bundle_changed:
                _shutdown_socket_daemon(paths, timeout=6.0)
                proc = _spawn_unmanaged_daemon(paths, node_bin, dest_bundle, enriched_path, node_modules_dir)
                health = _wait_for_daemon_ready(paths, spawned_proc=proc, avoid_pid=live.get('pid'))
            else:
                proc = _spawn_unmanaged_daemon(paths, node_bin, dest_bundle, enriched_path, node_modules_dir)
                health = _wait_for_daemon_ready(paths, spawned_proc=proc)

        result = {
            'ok': True,
            'installed': True,
            'autostart': autostart_mode,
            'bundlePath': str(dest_bundle),
            'socketPath': str(paths['socket_path']),
            'hostId': identity['hostId'],
            'hostName': identity['hostName'],
            'pid': health.get('pid'),
        }
        if linger_hint:
            result['lingerHint'] = linger_hint
        return result


def uninstall_daemon_service():
    paths = daemon_paths()
    with _cli_lifecycle_lock(paths):
        removed = []
        if sys.platform == 'darwin' and not paths['isolated_cfg']:
            plist_path = _launchd_plist_path(paths)
            if plist_path.is_file():
                uid = os.getuid() if hasattr(os, 'getuid') else 0
                subprocess.run(['launchctl', 'bootout', f'gui/{uid}', str(plist_path)], capture_output=True, check=False)
                plist_path.unlink(missing_ok=True)
                removed.append(str(plist_path))
        elif _systemd_user_available(paths):
            unit_path = _systemd_unit_path(paths)
            subprocess.run(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT], capture_output=True, check=False)
            if unit_path.is_file():
                unit_path.unlink(missing_ok=True)
                removed.append(str(unit_path))
            subprocess.run(['systemctl', '--user', 'daemon-reload'], capture_output=True, check=False)
        else:
            autostart_script = Path('/workspace/autostart/services.d/30-html-preview-daemon.sh')
            if not paths['isolated_cfg'] and autostart_script.is_file() and os.access(autostart_script.parent, os.W_OK):
                autostart_script.unlink(missing_ok=True)
                removed.append(str(autostart_script))

        stop_info = stop_daemon_process()
        return {
            'ok': True,
            'uninstalled': True,
            'stopped': stop_info.get('stopped', False),
            'removed': removed,
        }


def daemon_status_payload():
    paths = daemon_paths()
    health = probe_daemon_health(timeout=4.0, full=True)
    host_info = None
    if paths['host_file'].is_file():
        try:
            host_info = json.loads(paths['host_file'].read_text(encoding='utf-8'))
        except (ValueError, OSError):
            host_info = None
    if health:
        return {
            'running': True,
            **health,
        }
    return {
        'ok': True,
        'running': False,
        'hostId': host_info.get('hostId') if isinstance(host_info, dict) else None,
        'hostName': host_info.get('hostName') if isinstance(host_info, dict) else None,
        'socketPath': str(paths['socket_path']),
        'logFile': str(paths['log_file']),
        'servers': [],
        'availableAgents': [],
    }


def _should_auto_start_daemon_on_login(no_daemon=False):
    if no_daemon:
        return False
    ci_val = (os.environ.get('CI') or '').strip().lower()
    if ci_val in {'1', 'true', 'yes'}:
        return False
    return True


def ensure_daemon_running(preferred_name=None):
    live = probe_daemon_health(timeout=1.5)
    if live:
        return live
    paths = daemon_paths()
    try:
        return start_daemon_process(preferred_name=preferred_name)
    except (ValueError, OSError) as exc:
        raise ValueError(
            f'Local html-preview daemon is required for interactive commands and failed to start: {exc}. '
            f'Fix: ensure Node.js >=24 is in PATH and daemon.mjs is built (`npm run build:skill` or `npm run build:daemon`), '
            f'then run `html-preview daemon start` or inspect logs at {paths["log_file"]}.'
        ) from None


def _require_prepare_upload_via_daemon(base, source_file=None, preferred_name=None):
    ensure_daemon_running(preferred_name=preferred_name)
    paths = daemon_paths()
    env_hints = {}
    for key in (
        'CLAUDE_CODE_SESSION_ID',
        'CLAUDE_SESSION_ID',
        'CLAUDECODE',
        'ANTIGRAVITY_CONVERSATION_ID',
        'AGY_SESSION_ID',
        'AGY_CONVERSATION_ID',
        'CODEX_THREAD_ID',
        'CODEX_SESSION_ID',
        'GROK_SESSION_ID',
    ):
        val = (os.environ.get(key) or '').strip()
        if val:
            env_hints[key] = val

    req_payload = {
        'serverUrl': base,
        'callerPid': os.getpid(),
        'callerPpid': os.getppid(),
        'cwd': str(Path.cwd()),
        'sourceFile': source_file,
        'envHints': env_hints,
    }
    res = _unix_socket_json(paths['socket_path'], 'POST', '/v1/prepare-upload', req_payload, timeout=1.5)
    if res and res[0] == 200 and isinstance(res[1], dict) and res[1].get('hostId'):
        return res[1]
    raise ValueError(
        f'Local html-preview daemon at {paths["socket_path"]} did not return session metadata. '
        f'Fix: run `html-preview daemon restart` or inspect logs at {paths["log_file"]}.'
    )


def user_id(base):
    token = token_for(base)
    if not token:
        raise ValueError('Sign in with: html-preview login <URL> (or set HTML_PREVIEW_TOKEN)')
    digest = hashlib.sha256(token.encode()).hexdigest()
    saved = credentials()
    identity = (
        _cred_entry(saved, base).get('identities', {}).get(digest)
        or (saved.get('identities', {}).get(digest) if isinstance(saved.get('identities'), dict) else None)
    )
    if not identity:
        session = request(base, '/api/session')
        user = session.get('user') or session.get('member') or {}
        if not session.get('authenticated') or not user.get('id'):
            raise ValueError('Sign in with: html-preview login <URL> (or set HTML_PREVIEW_TOKEN)')
        identity = user['id']
        saved.setdefault('identities', {})[digest] = identity
        saved.setdefault(base, {}).setdefault('identities', {})[digest] = identity
        saved.setdefault('servers', {}).setdefault(base, {}).setdefault('identities', {})[digest] = identity
        try:
            save_credentials(saved)
        except OSError:
            pass
    return identity


def binding_key(config_path, source):
    return Path(os.path.relpath(Path(source).resolve(), config_path.parent)).as_posix()


def archive_match(archives, selector):
    return next((item for item in archives if selector in {item.get('id'), item.get('publicId'), item.get('name')}), None)


def resolve_page(base, config_path, server, path=None, archive_id=None, name=None):
    if sum(bool(value) for value in (path, archive_id, name)) != 1:
        raise ValueError('Pass exactly one of a file path, --id, or --name')
    catalog_data = request(base, '/api/catalog')
    archives = catalog_data.get('archives') or []
    if path:
        key = binding_key(config_path, path)
        binding = server.setdefault('files', {}).get(key) or {}
        if not binding.get('id'):
            raise ValueError('No saved binding for this file. Upload it first, or pass --id.')
        item = archive_match(archives, binding['id'])
    else:
        key = None
        item = archive_match(archives, archive_id or name)
    if not item:
        raise ValueError('HTML not found')
    return item, key


def sync_binding(server, item):
    folder = item.get('folder') or ''
    project, _, task = folder.partition('/')
    changed = False
    for binding in server.setdefault('files', {}).values():
        if binding.get('id') != item.get('id'):
            continue
        if project and binding.get('project') != project:
            binding['project'] = project
            changed = True
        if task and binding.get('task') != task:
            binding['task'] = task
            changed = True
    return changed


def drop_binding(server, item_id):
    files = server.setdefault('files', {})
    removed = [key for key, binding in files.items() if binding.get('id') == item_id]
    for key in removed:
        del files[key]
    return removed


def page_summary(item):
    return {key: item.get(key) for key in ('id', 'name', 'title', 'folder')}


def device_login(base, name=None, timeout=900, sleep=None, no_daemon=False):
    if timeout is None or timeout <= 0:
        raise ValueError('--timeout must be positive')
    if sleep is None:
        sleep = time.sleep
    try:
        hostname = socket.gethostname()
    except OSError:
        hostname = ''
    client_name = (name or '').strip() or hostname or 'html-preview-cli'
    code_res = request(base, '/auth/device/code', 'POST', {'client_name': client_name}, auth=False)
    device_code = code_res.get('device_code')
    user_code = code_res.get('user_code')
    verify_url = code_res.get('verification_uri_complete') or code_res.get('verification_uri')
    if not device_code or not user_code or not verify_url:
        raise ValueError('Invalid device authorization response')
    interval = max(1, int(code_res.get('interval') or 5))
    expires_in = float(code_res.get('expires_in') or 900)
    deadline = min(float(timeout), expires_in)
    print(
        f'Open this URL on any device signed in with GitHub and confirm code {user_code}:\n  {verify_url}',
        file=sys.stderr,
        flush=True,
    )
    elapsed = 0.0
    transient_failures = 0
    while True:
        try:
            res = _open_json(base, '/auth/device/token', 'POST', {'device_code': device_code}, auth=False)
            transient_failures = 0
            break
        except urllib.error.HTTPError as error:
            try:
                body = json.load(error)
            except (ValueError, AttributeError, TypeError):
                body = {}
            finally:
                error.close()
            err_code = body.get('error') if isinstance(body, dict) else None
            if error.code == 400 and err_code in {'authorization_pending', 'slow_down'}:
                transient_failures = 0
                if err_code == 'slow_down':
                    interval += 2
                if elapsed + interval > deadline:
                    if timeout < expires_in:
                        raise ValueError('Device login timed out; run html-preview login again') from None
                    raise ValueError('Device code expired; run html-preview login again') from None
                started = time.monotonic()
                sleep(interval)
                elapsed += max(float(interval), time.monotonic() - started)
                continue
            if 500 <= error.code < 600 and transient_failures < 4 and elapsed + interval <= deadline:
                transient_failures += 1
                started = time.monotonic()
                sleep(interval)
                elapsed += max(float(interval), time.monotonic() - started)
                continue
            if error.code == 400 and err_code == 'access_denied':
                raise ValueError('Device login was denied') from None
            if error.code == 400 and err_code == 'expired_token':
                raise ValueError('Device code expired; run html-preview login again') from None
            detail = err_code or error.reason
            raise ValueError(f'HTTP {error.code}: {detail}') from None
        except (urllib.error.URLError, TimeoutError, socket.timeout):
            if transient_failures < 4 and elapsed + interval <= deadline:
                transient_failures += 1
                started = time.monotonic()
                sleep(interval)
                elapsed += max(float(interval), time.monotonic() - started)
                continue
            raise ValueError('Cannot connect to html-preview; check the URL and network.') from None

    token = (res.get('access_token') or '').strip()
    user = res.get('user') or {}
    uid = user.get('id')
    login = user.get('login')
    if not token or '\n' in token or '\r' in token or not uid:
        raise ValueError('Invalid token response from service')
    digest = hashlib.sha256(token.encode()).hexdigest()
    saved = credentials()
    if not isinstance(saved, dict):
        saved = {}
    for target in (saved.setdefault('servers', {}).setdefault(base, {}), saved.setdefault(base, {})):
        target['token'] = token
        if res.get('token_id') is not None:
            target['tokenId'] = res.get('token_id')
        if login is not None:
            target['user'] = login
        target.setdefault('identities', {})[digest] = uid
    saved.setdefault('identities', {})[digest] = uid
    save_credentials(saved)

    result = {
        'ok': True,
        'url': base,
        'user': login,
        'tokenId': res.get('token_id'),
    }

    # Auto-install & start local daemon upon login unless --no-daemon or CI=true
    if _should_auto_start_daemon_on_login(no_daemon=no_daemon):
        try:
            daemon_info = install_daemon_service(preferred_name=name)
        except (ValueError, OSError) as exc:
            paths = daemon_paths()
            raise ValueError(
                f'Logged in as {login} and saved credentials, but failed to install/start local daemon: {exc}. '
                f'Fix: ensure Node.js >=24 is in PATH and run `html-preview daemon install` '
                f'(or pass `--no-daemon` for stateless API-only use; logs: {paths["log_file"]}).'
            ) from None
        result['daemon'] = {
            'running': True,
            'hostId': daemon_info.get('hostId'),
            'hostName': daemon_info.get('hostName'),
            'autostart': daemon_info.get('autostart'),
        }

    return output(result)


def logout(base):
    path = credential_path()
    if path.is_file():
        saved = credentials()
        if isinstance(saved, dict):
            digests = set()
            servers = saved.get('servers')
            entries = []
            if isinstance(servers, dict) and base in servers:
                entries.append(servers.pop(base))
            if base in saved and base not in {'servers', 'identities'}:
                entries.append(saved.pop(base))
            for entry in entries:
                if isinstance(entry, dict):
                    tok = entry.get('token')
                    if isinstance(tok, str) and tok:
                        digests.add(hashlib.sha256(tok.encode()).hexdigest())
                    idents = entry.get('identities')
                    if isinstance(idents, dict):
                        digests.update(idents.keys())
            if digests and isinstance(saved.get('identities'), dict):
                still_used = set()
                remaining_entries = []
                if isinstance(servers, dict):
                    remaining_entries.extend(servers.values())
                for k, v in saved.items():
                    if k not in {'servers', 'identities'}:
                        remaining_entries.append(v)
                for entry in remaining_entries:
                    if isinstance(entry, dict):
                        tok = entry.get('token')
                        if isinstance(tok, str) and tok:
                            still_used.add(hashlib.sha256(tok.encode()).hexdigest())
                        idents = entry.get('identities')
                        if isinstance(idents, dict):
                            still_used.update(idents.keys())
                for digest in digests - still_used:
                    saved['identities'].pop(digest, None)
            save_credentials(saved)
    # Notify running local daemon (if any) to drop the logged-out server connection immediately
    _unix_socket_json(daemon_paths()['socket_path'], 'POST', '/v1/reload', {}, timeout=0.15)
    return output({'ok': True, 'url': base})


KNOWN_COMMANDS = {
    'login',
    'logout',
    'daemon',
    'serve',
    'session',
    'catalog',
    'projects',
    'versions',
    'init',
    'upload',
    'bind',
    'edit',
    'delete',
    'share',
    'unshare',
    'reply',
}
REMOVED_COMMANDS = {'key', 'publish'}


def _normalize_argv(raw_args):
    args = list(raw_args)
    idx = 0
    while idx < len(args):
        tok = args[idx]
        if tok == '--base-url':
            idx += 2
            continue
        if tok.startswith('--base-url='):
            idx += 1
            continue
        if tok in {'-h', '--help'} or tok.startswith('-'):
            return args
        if tok not in KNOWN_COMMANDS and tok not in REMOVED_COMMANDS:
            lower = tok.lower()
            if (
                lower.endswith(('.html', '.htm', '.zip'))
                or '/' in tok
                or '\\' in tok
                or tok in {'.', '..'}
                or Path(tok).exists()
            ):
                args.insert(idx, 'upload')
        return args
    return args


def _run_daemon_subcommand(args):
    action = args.daemon_action
    if action == 'install':
        return output(install_daemon_service(preferred_name=args.name))
    if action == 'uninstall':
        return output(uninstall_daemon_service())
    if action == 'start':
        health = start_daemon_process(preferred_name=args.name)
        return output({'running': True, **health})
    if action == 'stop':
        return output(stop_daemon_process())
    if action == 'restart':
        health = restart_daemon_process(preferred_name=args.name)
        return output({'running': True, **health})
    if action == 'status':
        return output(daemon_status_payload())
    if action == 'drain':
        health = ensure_daemon_running(preferred_name=args.name)
        paths = daemon_paths()
        res = _unix_socket_json(paths['socket_path'], 'POST', '/v1/drain', {}, timeout=30.0)
        if not res or res[0] != 200 or not isinstance(res[1], dict):
            raise ValueError(
                f'Failed to drain deliveries via local daemon at {paths["socket_path"]}. '
                f'Fix: run `html-preview daemon restart` or inspect logs at {paths["log_file"]}.'
            )
        return output({
            'ok': True,
            'claimed': res[1].get('claimed', 0),
            'hostId': health.get('hostId'),
            'hostName': health.get('hostName'),
        })
    if action == 'logs':
        log_file = daemon_paths()['log_file']
        if not log_file.is_file():
            if args.json:
                return output({'logFile': str(log_file), 'lines': []})
            return None
        if args.follow:
            os.execvp('tail', ['tail', '-n', str(max(1, args.lines)), '-f', str(log_file)])
        lines = log_file.read_text(encoding='utf-8', errors='replace').splitlines()[-max(1, args.lines):]
        if args.json:
            return output({'logFile': str(log_file), 'lines': lines})
        for line in lines:
            print(line)
        return None
    raise ValueError(f'Unknown daemon action: {action}')


def _extract_flag_arg(args, flags):
    for i, arg in enumerate(args):
        for flag in flags:
            if arg == flag and i + 1 < len(args) and args[i + 1].strip():
                return args[i + 1].strip()
            if arg.startswith(flag + '='):
                val = arg[len(flag) + 1:].strip()
                if val:
                    return val
    return None


def _run_cooperative_session(raw_args):
    if not raw_args or raw_args[0] in {'-h', '--help'}:
        print(
            'usage: html-preview session <claude|agy> [agent_args...]\n\n'
            'Launch Claude Code or Antigravity CLI under a shared OS flock session mutex\n'
            'coordinated with the local html-preview daemon so web & terminal never dual-write.',
        )
        return 0
    adapter = raw_args[0].strip().lower()
    if adapter not in {'claude', 'agy'}:
        raise ValueError("html-preview session supports non-shared agents: 'claude' or 'agy'")
    agent_args = list(raw_args[1:])
    if agent_args and agent_args[0] == '--':
        agent_args = agent_args[1:]

    env = dict(os.environ)
    session_id = None
    if adapter == 'claude':
        session_id = (
            _extract_flag_arg(agent_args, ['--resume', '-r', '--session-id'])
            or env.get('CLAUDE_CODE_SESSION_ID')
            or env.get('CLAUDE_SESSION_ID')
        )
        if not session_id and '-c' not in agent_args and '--continue' not in agent_args:
            session_id = str(uuid.uuid4())
            agent_args = ['--session-id', session_id, *agent_args]
        if session_id:
            env['CLAUDE_CODE_SESSION_ID'] = session_id
    else:
        session_id = (
            _extract_flag_arg(agent_args, ['--conversation', '--resume', '--session'])
            or env.get('ANTIGRAVITY_CONVERSATION_ID')
            or env.get('AGY_SESSION_ID')
            or env.get('AGY_CONVERSATION_ID')
        )
        if session_id:
            env['AGY_SESSION_ID'] = session_id

    bin_override = env.get('CLAUDE_BIN' if adapter == 'claude' else 'AGY_BIN')
    binary = bin_override or shutil.which(adapter)
    if not binary:
        raise ValueError(f"Agent CLI '{adapter}' not found in PATH")

    ensure_daemon_running()
    paths = daemon_paths()
    lock_fd = None
    owner_file = None
    if session_id:
        safe_id = re.sub(r'[^A-Za-z0-9_-]', '_', session_id)
        lock_dir = paths['state_dir'] / 'locks'
        lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            lock_dir.chmod(0o700)
        except OSError:
            pass
        _unix_socket_json(
            paths['socket_path'],
            'POST',
            '/v1/release-session',
            {'adapterId': adapter, 'sessionId': session_id, 'waitMs': 10000},
            timeout=12.0,
        )
        lock_file = lock_dir / f'{adapter}__{safe_id}.lock'
        owner_file = lock_dir / f'{adapter}__{safe_id}.owner.json'
        flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_CLOEXEC', 0)
        lock_fd = os.open(str(lock_file), flags, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)

    child = None
    prev_sigterm = signal.getsignal(signal.SIGTERM)
    prev_sighup = signal.getsignal(signal.SIGHUP) if hasattr(signal, 'SIGHUP') else None
    try:
        child = subprocess.Popen([binary, *agent_args], env=env)
        if owner_file is not None:
            _atomic_write_secure_json(owner_file, {
                'holder': 'terminal',
                'pid': child.pid,
                'wrapperPid': os.getpid(),
                'adapterId': adapter,
                'sessionId': session_id,
                'cwd': str(Path.cwd()),
                'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            })

        def _forward_sig(signum, _frame):
            if child is not None and child.poll() is None:
                try:
                    child.send_signal(signum)
                except OSError:
                    pass

        signal.signal(signal.SIGTERM, _forward_sig)
        if hasattr(signal, 'SIGHUP'):
            signal.signal(signal.SIGHUP, _forward_sig)

        while True:
            try:
                rc = child.wait()
                break
            except KeyboardInterrupt:
                if child.poll() is None:
                    try:
                        child.send_signal(signal.SIGINT)
                    except OSError:
                        pass
        sys.exit(rc if rc >= 0 else 128 + abs(rc))
    finally:
        signal.signal(signal.SIGTERM, prev_sigterm)
        if hasattr(signal, 'SIGHUP') and prev_sighup is not None:
            signal.signal(signal.SIGHUP, prev_sighup)
        if owner_file is not None:
            try:
                owner_file.unlink(missing_ok=True)
            except OSError:
                pass
        if lock_fd is not None:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                os.close(lock_fd)
            except OSError:
                pass
        _unix_socket_json(
            paths['socket_path'],
            'POST',
            '/v1/drain',
            {'includeDeferred': True},
            timeout=0.3,
        )


def main():
    global _credential_context
    _credential_context = None

    norm_argv = _normalize_argv(sys.argv[1:])
    if norm_argv and norm_argv[0] == 'serve':
        node_bin, dest_bundle, enriched_path, node_modules_dir, _changed = _install_daemon_bundle_and_runner()
        os.environ['PATH'] = enriched_path
        if node_modules_dir is not None:
            os.environ['HTML_PREVIEW_NODE_MODULES'] = str(node_modules_dir)
        os.execv(node_bin, [node_bin, str(dest_bundle), 'serve', *norm_argv[1:]])
    if norm_argv and norm_argv[0] == 'session':
        return _run_cooperative_session(norm_argv[1:])

    parser = argparse.ArgumentParser(
        prog='html-preview',
        description='Manage personal HTML previews, versions, public share links, and local agent daemon.'
    )
    parser.add_argument('--base-url', help='Service origin (or HTML_PREVIEW_URL / project config)')
    sub = parser.add_subparsers(dest='command', required=True)

    sign_in = sub.add_parser('login', help='Sign in with GitHub device authorization')
    sign_in.add_argument('url', nargs='?')
    sign_in.add_argument('--name', help='Device/machine display name')
    sign_in.add_argument('--timeout', type=int, default=900, help='Maximum seconds to wait for approval')
    sign_in.add_argument('--no-daemon', action='store_true', help='Skip installing/starting the local daemon')

    sign_out = sub.add_parser('logout', help='Remove saved credentials for a service')
    sign_out.add_argument('url', nargs='?')

    daemon_cmd = sub.add_parser('daemon', help='Manage the local html-preview background daemon')
    daemon_cmd.add_argument(
        'daemon_action',
        nargs='?',
        choices=['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'drain'],
        default='status',
    )
    daemon_cmd.add_argument('--url', help='Service origin')
    daemon_cmd.add_argument('--name', help='Override local machine display name')
    daemon_cmd.add_argument('--json', action='store_true', help='Emit JSON output')
    daemon_cmd.add_argument('-f', '--follow', action='store_true', help='Follow daemon logs')
    daemon_cmd.add_argument('-n', '--lines', type=int, default=100, help='Number of log lines to show')

    session_cmd = sub.add_parser(
        'session',
        help='Launch Claude Code or Antigravity CLI under shared OS session mutex',
    )
    session_cmd.add_argument('agent', choices=['claude', 'agy'])
    session_cmd.add_argument('agent_args', nargs=argparse.REMAINDER)

    catalog = sub.add_parser('catalog')
    catalog.add_argument('--url')

    projects = sub.add_parser('projects')
    projects.add_argument('action', nargs='?', choices=['list'], default='list')
    projects.add_argument('--url')

    versions = sub.add_parser('versions')
    versions.add_argument('name')
    versions.add_argument('--url')

    init = sub.add_parser('init')
    init.add_argument('--project', required=True)
    init.add_argument('--task', required=True)
    init.add_argument('--url')

    upload = sub.add_parser('upload', help='Upload an HTML deliverable to personal workspace')
    upload.add_argument('path')
    upload.add_argument('--name')
    upload.add_argument('--project')
    upload.add_argument('--task')
    upload.add_argument('--title')
    upload.add_argument('--note', default='')
    upload.add_argument('--version', type=int)
    upload.add_argument('--url')
    upload.add_argument('--no-config', action='store_true')
    upload.add_argument('--bind', action='store_true', help='Bind this version to the local daemon host & coding session (requires daemon)')
    upload.add_argument('--resolves', action='append')

    reply = sub.add_parser('reply', help='Reply to or resolve a bidirectional HTML interaction (requires daemon)')
    reply.add_argument('interaction_id')
    reply.add_argument('url', nargs='?')
    reply.add_argument('--url', dest='url_opt')
    reply.add_argument('--text')
    reply.add_argument('--status', choices=['replied', 'needs_attention', 'resolved'], default='replied')
    reply.add_argument('--summary')

    bind = sub.add_parser('bind', help='Backfill local host & coding session binding for a page (requires daemon)')
    bind.add_argument('path', nargs='?')
    bind.add_argument('--id')
    bind.add_argument('--name')
    bind.add_argument('--version', type=int)
    bind.add_argument('--url')

    edit = sub.add_parser('edit', help='Change the title or folder of an existing page')
    edit.add_argument('path', nargs='?')
    edit.add_argument('--id')
    edit.add_argument('--name')
    edit.add_argument('--title')
    edit.add_argument('--project')
    edit.add_argument('--task')
    edit.add_argument('--folder')
    edit.add_argument('--url')

    delete = sub.add_parser('delete', help='Delete one page')
    delete.add_argument('path', nargs='?')
    delete.add_argument('--id')
    delete.add_argument('--name')
    delete.add_argument('--yes', action='store_true')
    delete.add_argument('--dry-run', action='store_true')
    delete.add_argument('--url')

    share = sub.add_parser('share', help='Create or get a public share link for a page')
    share.add_argument('path', nargs='?')
    share.add_argument('--id')
    share.add_argument('--name')
    share.add_argument('--url')

    unshare = sub.add_parser('unshare', help='Revoke the public share link for a page')
    unshare.add_argument('path', nargs='?')
    unshare.add_argument('--id')
    unshare.add_argument('--name')
    unshare.add_argument('--url')

    args = parser.parse_args(norm_argv)
    if args.command == 'daemon':
        return _run_daemon_subcommand(args)

    config_path, settings = config()
    explicit_url = getattr(args, 'url_opt', None) or getattr(args, 'url', None)
    base = (explicit_url or args.base_url or os.environ.get('HTML_PREVIEW_URL') or settings.get('url') or DEFAULT_URL).rstrip('/')
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.query or parsed.fragment or parsed.username or parsed.path.strip('/'):
        raise ValueError('Use an HTTP(S) origin without credentials, path, query or fragment')

    if args.command == 'login':
        return device_login(base, args.name, args.timeout, no_daemon=args.no_daemon)
    if args.command == 'logout':
        return logout(base)

    _credential_context = (base, token_for(base))

    if args.command == 'catalog':
        return output(request(base, '/api/catalog'))
    if args.command == 'projects':
        catalog_data = request(base, '/api/catalog')
        return output({'projects': catalog_data.get('projects', [])})
    if args.command == 'versions':
        catalog_data = request(base, '/api/catalog')
        item = next((a for a in catalog_data.get('archives', []) if a.get('name') == args.name or a.get('id') == args.name), None)
        if not item:
            raise ValueError('HTML not found')
        return output(item)
    if args.command == 'reply':
        interaction_id = (args.interaction_id or '').strip()
        if not interaction_id or '\n' in interaction_id or '\r' in interaction_id:
            raise ValueError('Invalid interaction_id')
        if args.status == 'replied' and not (args.text or '').strip():
            raise ValueError('Pass --text when --status is replied')
        ensure_daemon_running()
        reply_payload = {
            'action': 'resolve' if args.status == 'resolved' else 'reply',
            'replyText': args.text,
            'status': args.status,
            'summary': args.summary,
        }
        return output(request(
            base,
            '/api/interactions/' + urllib.parse.quote(interaction_id, safe='') + '/reply',
            'POST',
            reply_payload,
        ))

    daemon_prepared = None
    resolved_ids = []
    if args.command == 'bind':
        if sum(bool(value) for value in (args.path, args.id, args.name)) != 1:
            raise ValueError('Pass exactly one of a file path, --id, or --name')
        daemon_prepared = _require_prepare_upload_via_daemon(
            base,
            binding_key(config_path, args.path) if args.path else None,
        )
    elif args.command == 'upload':
        env_interaction_id = (os.environ.get('HTML_PREVIEW_INTERACTION_ID') or '').strip()
        if env_interaction_id:
            resolved_ids.append(env_interaction_id)
        if args.resolves:
            for raw in args.resolves:
                for part in raw.split(','):
                    item_id = part.strip()
                    if item_id and item_id not in resolved_ids:
                        resolved_ids.append(item_id)
        if args.bind or resolved_ids:
            daemon_prepared = _require_prepare_upload_via_daemon(
                base,
                binding_key(config_path, args.path),
            )

    servers = settings.setdefault('servers', {})
    server = servers.setdefault(base, {}).setdefault('members', {}).setdefault(user_id(base), {})

    if args.command == 'bind':
        item, _key = resolve_page(base, config_path, server, args.path, args.id, args.name)
        bind_payload = {
            'hostId': daemon_prepared['hostId'],
            'hostName': daemon_prepared.get('hostName'),
            'binding': daemon_prepared.get('binding'),
        }
        if args.version is not None:
            bind_payload['version'] = args.version
        return output(request(
            base,
            '/api/archives/' + urllib.parse.quote(item['id'], safe='') + '/bindings',
            'POST',
            bind_payload,
        ))

    if args.command == 'init':
        server.update({'project': args.project, 'task': args.task})
        settings.setdefault('url', base)
        save_config(config_path, settings)
        return output({'config': str(config_path), 'url': base, 'project': args.project, 'task': args.task})

    if args.command in {'share', 'unshare'}:
        item, _key = resolve_page(base, config_path, server, args.path, args.id, args.name)
        method = 'POST' if args.command == 'share' else 'DELETE'
        res = request(base, '/api/archives/' + urllib.parse.quote(item['id'], safe='') + '/share', method)
        matched = False
        for binding in server.setdefault('files', {}).values():
            if binding.get('id') != item['id']:
                continue
            matched = True
            if args.command == 'share' and res.get('shareUrl'):
                binding['shareUrl'] = res['shareUrl']
            else:
                binding.pop('shareUrl', None)
        if matched:
            save_config(config_path, settings)
        return output(res)

    if args.command in {'edit', 'delete'}:
        if args.command == 'edit':
            if args.folder and (args.project or args.task):
                raise ValueError('Pass either --folder or --project with --task')
            if bool(args.project) != bool(args.task):
                raise ValueError('Supply --project and --task together')
        item, _key = resolve_page(base, config_path, server, args.path, args.id, args.name)
        if args.command == 'delete':
            summary = page_summary(item)
            if args.dry_run:
                return output({'dryRun': True, **summary})
            if not args.yes:
                output({'status': 'needs_confirm', **summary, 'next': 'Re-run with --yes to delete this page.'})
                raise SystemExit(2)
            request(base, '/api/archives/' + urllib.parse.quote(item['id'], safe=''), 'DELETE')
            removed = drop_binding(server, item['id'])
            if removed:
                save_config(config_path, settings)
            return output({'ok': True, 'id': item['id'], 'removed': removed})
        payload = {}
        if args.title:
            payload['title'] = args.title
        if args.folder:
            payload['folder'] = args.folder
        elif args.project:
            payload['folder'] = f'{args.project}/{args.task}'
        if not payload:
            raise ValueError('Pass --title, --project and --task, or --folder')
        result = request(base, '/api/archives/' + urllib.parse.quote(item['id'], safe=''), 'PATCH', payload)
        if sync_binding(server, result):
            save_config(config_path, settings)
        return output(result)

    artifact_key = Path(os.path.relpath(Path(args.path).resolve(), config_path.parent)).as_posix()
    files = server.setdefault('files', {})
    binding = {} if args.no_config else files.get(artifact_key, {})
    if args.name and args.name != binding.get('name'):
        binding = {}
    name = args.name or binding.get('name') or 'html-' + uuid.uuid4().hex
    project_name = args.project or binding.get('project') or server.get('project')
    task_name = args.task or binding.get('task') or server.get('task')
    if args.project and args.project != (binding.get('project') or server.get('project')):
        task_name = args.task
    if not project_name or not task_name:
        catalog_data = request(base, '/api/catalog')
        projects = catalog_data.get('projects', [])
        output({
            'status': 'needs_destination',
            'projects': [{'name': p['name'], 'tasks': p.get('tasks', [])} for p in projects],
            'next': 'Choose project/task, then upload with --project and --task. New categories are created on upload.'
        })
        raise SystemExit(2)
    if len(name) > 64 or not re.fullmatch(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*', name):
        raise ValueError('--name must be kebab-case and contain at most 64 characters')

    payload, content_type = prepare(args.path)
    params = {
        'name': name,
        'note': args.note,
        'project': project_name,
        'task': task_name,
    }
    if not binding and not args.title:
        page = Path(args.path)
        title = PageTitle()
        html = ''
        if content_type == 'text/html':
            html = payload[:65536].decode('utf-8', errors='replace')
        elif page.is_dir():
            with (page / 'index.html').open('rb') as stream:
                html = stream.read(65536).decode('utf-8', errors='replace')
        title.feed(html)
        args.title = (' '.join(''.join(title.parts).split()) or page.stem)[:100]
    if args.title:
        params['title'] = args.title

    if resolved_ids:
        params['resolves'] = ','.join(resolved_ids)

    if daemon_prepared:
        params['host_id'] = daemon_prepared['hostId']
        if daemon_prepared.get('hostName'):
            params['host_name'] = daemon_prepared['hostName']
        if daemon_prepared.get('binding'):
            params['binding'] = daemon_prepared['binding']

    try:
        result = request(base, '/upload?' + urllib.parse.urlencode(params), 'POST', payload, content_type)
    except (ValueError, OSError) as error:
        raise ValueError(str(error) + '; HTML name: ' + name + '. Check versions before retrying a timed-out upload.') from None
    if not args.no_config:
        saved_binding = {
            'id': result['id'],
            'name': name,
            'project': project_name,
            'task': task_name,
            'version': result['version'],
            'url': result['url'],
            'versionUrl': result['versionUrl'],
        }
        if 'shareUrl' in result or 'shared' in result:
            share_url = result.get('shareUrl') if result.get('shared', True) else None
        elif binding.get('id') == result['id']:
            share_url = binding.get('shareUrl')
        else:
            share_url = None
        if share_url:
            saved_binding['shareUrl'] = share_url
        files[artifact_key] = saved_binding
        settings.setdefault('url', base)
        if not server.get('project') and not server.get('task'):
            server.update({'project': project_name, 'task': task_name})
        try:
            save_config(config_path, settings)
        except OSError:
            print('Upload succeeded; binding could not be saved. Keep this name: ' + name, file=sys.stderr)
    output(result)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        print(f'html-preview: {error}', file=sys.stderr)
        sys.exit(1)
