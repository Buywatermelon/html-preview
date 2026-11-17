from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import zipfile

spec = importlib.util.spec_from_file_location('html_preview', Path(__file__).parents[1] / 'skills/html-preview/scripts/html-preview.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.identity = patch.object(cli, 'user_id', return_value='alice')
        self.identity.start()
        self.addCleanup(self.identity.stop)
        self.clean_session_env = patch.dict(
            os.environ,
            {
                'CLAUDE_SESSION_ID': '',
                'CLAUDECODE': '',
                'AGY_SESSION_ID': '',
                'ANTIGRAVITY_CONVERSATION_ID': '',
                'CODEX_THREAD_ID': '',
                'HTML_PREVIEW_INTERACTION_ID': '',
                'HTML_PREVIEW_DAEMON_SOCK': '/tmp/hp-nonexistent-unit-test.sock',
            },
            clear=False,
        )
        self.clean_session_env.start()
        self.addCleanup(self.clean_session_env.stop)

    def run_cli(self, cwd, *args):
        previous = Path.cwd()
        try:
            os.chdir(cwd)
            stdout = io.StringIO()
            with patch.object(sys, 'argv', ['html-preview', *args]), redirect_stdout(stdout):
                cli.main()
            return json.loads(stdout.getvalue())
        finally:
            os.chdir(previous)

    def service(self):
        calls, versions, shares = [], {}, {}
        def request(base, path, method='GET', payload=None, kind=None):
            calls.append((base, path, method, payload))
            if method == 'GET':
                if path == '/api/session':
                    return {'authenticated': True, 'user': {'id': 'alice', 'login': 'alice'}}
                archives = [{
                    'id': 'doc-existing',
                    'name': 'existing-page',
                    'title': '已有页面',
                    'folder': '产品/报告',
                    'shared': bool(shares.get((base, 'doc-existing'))),
                    'shareUrl': shares.get((base, 'doc-existing')),
                    'sharedAt': '2026-11-13T00:00:00Z' if shares.get((base, 'doc-existing')) else None,
                }]
                for (srv, doc_name), ver in versions.items():
                    if srv == base:
                        doc_id = 'document-' + doc_name
                        share_url = shares.get((base, doc_id))
                        archives.append({
                            'id': doc_id,
                            'name': doc_name,
                            'title': doc_name,
                            'folder': '产品/报告',
                            'version': ver,
                            'shared': bool(share_url),
                            'shareUrl': share_url,
                            'sharedAt': '2026-11-13T00:00:00Z' if share_url else None,
                        })
                return {
                    'projects': [{'name': '产品', 'tasks': ['报告']}],
                    'archives': archives,
                }
            if path.endswith('/share'):
                doc_id = urllib.parse.unquote(path.split('/')[3])
                if method == 'POST':
                    share_url = shares.setdefault((base, doc_id), base + '/s/tok-' + doc_id + '/')
                    return {
                        'id': doc_id,
                        'name': doc_id.removeprefix('document-'),
                        'title': '标题',
                        'folder': '产品/报告',
                        'shared': True,
                        'shareUrl': share_url,
                        'sharedAt': '2026-11-13T00:00:00Z',
                    }
                if method == 'DELETE':
                    shares.pop((base, doc_id), None)
                    return {
                        'id': doc_id,
                        'name': doc_id.removeprefix('document-'),
                        'title': '标题',
                        'folder': '产品/报告',
                        'shared': False,
                        'shareUrl': None,
                        'sharedAt': None,
                    }
            if path.endswith('/bindings') and method == 'POST':
                doc_id = urllib.parse.unquote(path.split('/')[3])
                return {
                    'id': doc_id,
                    'binding': payload,
                }
            params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(path).query))
            key = (base, params['name'])
            versions[key] = versions.get(key, 0) + 1
            doc_id = 'document-' + params['name']
            share_url = shares.get((base, doc_id))
            return {
                'id': doc_id,
                'name': params['name'],
                'version': versions[key],
                'url': base + '/p/' + params['name'] + '/',
                'versionUrl': base + '/p/' + params['name'] + '/v' + str(versions[key]) + '/',
                'shared': bool(share_url),
                'shareUrl': share_url,
            }
        return calls, request

    def test_directory_packaging_keeps_assets_and_excludes_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'index.html').write_text('<h1>Preview</h1>')
            (root / 'assets').mkdir()
            (root / 'assets/a.css').write_text('body{}')
            for name in ['.env', '.dev.vars', '.html-preview.json']:
                (root / name).write_text('secret')
            payload, kind = cli.prepare(root)
            self.assertEqual(kind, 'application/zip')
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                self.assertEqual(sorted(archive.namelist()), ['assets/a.css', 'index.html'])
            (root / 'assets/link').symlink_to(root / 'index.html')
            with self.assertRaisesRegex(ValueError, 'regular files'):
                cli.prepare(root)

    def test_limits_and_missing_root_fail_before_upload(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, 'index.html'):
                cli.prepare(root)
            page = root / 'large.html'
            with page.open('wb') as stream:
                stream.truncate(cli.MAX_BYTES + 1)
            with self.assertRaisesRegex(ValueError, '20 MiB'):
                cli.prepare(page)

    def test_upload_reuses_the_binding_with_one_post_and_reads_the_title(self):
        calls, service = self.service()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=service), patch.dict(os.environ, {'HTML_PREVIEW_URL': '', 'HTML_PREVIEW_TOKEN': ''}):
            root = Path(tmp)
            (root / 'outputs').mkdir()
            page = root / 'outputs/report.html'
            page.write_text('<title>方案 &amp; 原型</title><script id="am-source"></script>')
            first = self.run_cli(root, 'upload', str(page), '--project', '产品', '--task', '报告')
            second = self.run_cli(page.parent, 'upload', 'report.html')
            self.assertEqual(first['id'], second['id'])
            self.assertEqual(second['version'], 2)
            self.assertEqual([call[2] for call in calls], ['POST', 'POST'])
            params = urllib.parse.parse_qs(urllib.parse.urlsplit(calls[0][1]).query)
            self.assertEqual(params['title'], ['方案 & 原型'])
            self.assertNotIn('scope', params)
            self.assertNotIn('kind', params)
            saved = json.loads((root / '.html-preview.json').read_text())
            binding = saved['servers'][cli.DEFAULT_URL]['members']['alice']['files']['outputs/report.html']
            self.assertEqual(binding['version'], 2)
            self.assertEqual(binding['url'], second['url'])
            self.assertEqual(binding['versionUrl'], second['versionUrl'])
            self.assertNotIn('shareUrl', binding)

    def test_missing_destination_reads_projects_from_catalog_without_saving(self):
        calls, service = self.service()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=service):
            root = Path(tmp)
            page = root / 'report.html'
            page.write_text('report')
            output = io.StringIO()
            previous = Path.cwd()
            try:
                os.chdir(root)
                with patch.object(sys, 'argv', ['html-preview', 'upload', str(page)]), redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
                    cli.main()
            finally:
                os.chdir(previous)
            self.assertEqual(stopped.exception.code, 2)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][1], '/api/catalog')
            payload = json.loads(output.getvalue())
            self.assertEqual(payload['status'], 'needs_destination')
            self.assertNotIn('scope', payload)
            self.assertEqual(payload['projects'], [{'name': '产品', 'tasks': ['报告']}])
            self.assertFalse((root / '.html-preview.json').exists())

    def test_catalog_projects_versions_and_init_operate_without_scope(self):
        calls, service = self.service()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=service), patch.dict(os.environ, {'HTML_PREVIEW_URL': ''}):
            root = Path(tmp)
            cat = self.run_cli(root, 'catalog')
            proj = self.run_cli(root, 'projects')
            ver = self.run_cli(root, 'versions', 'existing-page')
            self.assertEqual([call[1] for call in calls], ['/api/catalog', '/api/catalog', '/api/catalog'])
            self.assertEqual(len(cat['archives']), 1)
            self.assertEqual(proj, {'projects': [{'name': '产品', 'tasks': ['报告']}]})
            self.assertEqual(ver['id'], 'doc-existing')
            initialized = self.run_cli(root, 'init', '--project', '产品', '--task', '报告')
            config_path = (root / '.html-preview.json').resolve()
            self.assertEqual(initialized, {
                'config': str(config_path),
                'url': cli.DEFAULT_URL,
                'project': '产品',
                'task': '报告',
            })
            saved = json.loads(config_path.read_text())
            self.assertEqual(saved['servers'][cli.DEFAULT_URL]['members']['alice'], {'project': '产品', 'task': '报告'})

    def test_the_same_file_keeps_independent_versions_for_two_services(self):
        calls, service = self.service()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=service):
            root = Path(tmp)
            page = root / 'report.html'
            page.write_text('report')
            for base in ['https://a.example', 'https://b.example']:
                self.run_cli(root, '--base-url', base, 'upload', str(page), '--project', '产品', '--task', '报告')
            a = self.run_cli(root, '--base-url', 'https://a.example', 'upload', str(page))
            b = self.run_cli(root, '--base-url', 'https://b.example', 'upload', str(page))
            self.assertEqual(a['version'], 2)
            self.assertEqual(b['version'], 2)
            saved = json.loads((root / '.html-preview.json').read_text())
            self.assertEqual(saved['url'], 'https://a.example')
            self.assertEqual(len(saved['servers']), 2)

    def test_two_accounts_at_one_service_keep_separate_file_bindings(self):
        calls, service = self.service()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=service), patch.dict(os.environ, {'HTML_PREVIEW_URL': ''}):
            root = Path(tmp)
            page = root / 'report.html'
            page.write_text('report')
            alice = self.run_cli(root, 'upload', str(page), '--project', '产品', '--task', '报告')
            with patch.object(cli, 'user_id', return_value='bob'):
                bob = self.run_cli(root, 'upload', str(page), '--project', '产品', '--task', '报告')
                self.assertNotEqual(alice['name'], bob['name'])
            alice_v2 = self.run_cli(root, 'upload', str(page))
            self.assertEqual(alice_v2['id'], alice['id'])
            self.assertEqual(alice_v2['version'], 2)
            saved = json.loads((root / '.html-preview.json').read_text())
            members = saved['servers'][cli.DEFAULT_URL]['members']
            self.assertEqual(members['alice']['files']['report.html']['version'], 2)
            self.assertEqual(members['bob']['files']['report.html']['version'], 1)

    def test_failed_upload_keeps_the_config(self):
        calls, service = self.service()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=service):
            root = Path(tmp)
            page = root / 'report.html'
            page.write_text('v1')
            self.run_cli(root, 'upload', str(page), '--project', '产品', '--task', '报告')
            before = (root / '.html-preview.json').read_text()
            with patch.object(cli, 'request', side_effect=ValueError('Storage unavailable')), self.assertRaisesRegex(ValueError, 'Check versions'):
                self.run_cli(root, 'upload', str(page))
            self.assertEqual((root / '.html-preview.json').read_text(), before)

    def test_an_upload_keeps_one_identity_if_another_login_changes_saved_credentials(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp, 'HTML_PREVIEW_TOKEN': ''}):
            root = Path(tmp)
            page = root / 'report.html'
            page.write_text('<h1>Report</h1>')
            credential = cli.credential_path()
            credential.parent.mkdir()
            credential.write_text(json.dumps({cli.DEFAULT_URL: {'token': 'alice-token'}}))
            original = cli.prepare
            def prepare(path):
                credential.write_text(json.dumps({cli.DEFAULT_URL: {'token': 'bob-token'}}))
                return original(path)
            headers = []
            def open_request(req, **kwargs):
                headers.append(req.get_header('Authorization'))
                return io.BytesIO(json.dumps({'id': 'alice-document', 'version': 1, 'url': cli.DEFAULT_URL+'/p/a/', 'versionUrl': cli.DEFAULT_URL+'/p/a/v1/'}).encode())
            with patch.object(cli, 'prepare', side_effect=prepare), patch.object(cli.urllib.request, 'urlopen', side_effect=open_request):
                self.run_cli(root, 'upload', str(page), '--project', '产品', '--task', '报告')
            self.assertEqual(headers, ['Bearer alice-token'])

    def test_login_polls_device_flow_saves_credentials_and_honors_ci_token_override(self):
        token = 'hp_' + 'a' * 48
        requests_seen, sleeps = [], []
        poll_count = 0

        def open_request(req, **kwargs):
            nonlocal poll_count
            body = json.loads(req.data.decode()) if req.data else None
            requests_seen.append((req.full_url, req.get_method(), req.get_header('Authorization'), body))
            if req.full_url == 'https://personal.example/auth/device/code':
                return io.BytesIO(json.dumps({
                    'device_code': 'dev_code_123',
                    'user_code': 'ABCD-1234',
                    'verification_uri': 'https://personal.example/device',
                    'verification_uri_complete': 'https://personal.example/device?user_code=ABCD-1234',
                    'expires_in': 900,
                    'interval': 5,
                }).encode())
            if req.full_url == 'https://personal.example/auth/device/token':
                poll_count += 1
                if poll_count == 1:
                    raise urllib.error.HTTPError(
                        req.full_url, 400, 'Bad Request', {},
                        io.BytesIO(json.dumps({'error': 'authorization_pending'}).encode()),
                    )
                if poll_count == 2:
                    raise urllib.error.URLError('temporary network blip')
                return io.BytesIO(json.dumps({
                    'access_token': token,
                    'token_id': 'tok_01',
                    'user': {'id': 'alice', 'login': 'alice'},
                }).encode())
            raise AssertionError(f'Unexpected URL: {req.full_url}')

        self.identity.stop()
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp, 'HTML_PREVIEW_TOKEN': '', 'CI': ''}, clear=False),
            patch.object(cli.urllib.request, 'urlopen', side_effect=open_request),
            patch.object(cli.time, 'sleep', side_effect=sleeps.append),
            patch.object(cli, 'install_daemon_service', return_value={
                'ok': True,
                'installed': True,
                'autostart': 'background-supervisor',
                'hostId': 'hst_testbox0000000000001',
                'hostName': 'my-box',
                'pid': 4242,
            }) as mock_install_daemon,
        ):
            os.environ.pop('HTML_PREVIEW_KEY', None)
            root = Path(tmp) / 'work'
            root.mkdir()
            stdout, stderr = io.StringIO(), io.StringIO()
            previous = Path.cwd()
            try:
                os.chdir(root)
                with (
                    patch.object(sys, 'argv', ['html-preview', 'login', 'https://personal.example', '--name', 'my-box']),
                    redirect_stdout(stdout),
                    redirect_stderr(stderr),
                ):
                    cli.main()
            finally:
                os.chdir(previous)

            res = json.loads(stdout.getvalue())
            self.assertEqual(res, {
                'ok': True,
                'url': 'https://personal.example',
                'user': 'alice',
                'tokenId': 'tok_01',
                'daemon': {
                    'running': True,
                    'hostId': 'hst_testbox0000000000001',
                    'hostName': 'my-box',
                    'autostart': 'background-supervisor',
                },
            })
            mock_install_daemon.assert_called_once_with(preferred_name='my-box')
            self.assertEqual(
                stderr.getvalue(),
                'Open this URL on any device signed in with GitHub and confirm code ABCD-1234:\n'
                '  https://personal.example/device?user_code=ABCD-1234\n',
            )
            self.assertEqual(sleeps, [5, 5])
            self.assertEqual(requests_seen, [
                ('https://personal.example/auth/device/code', 'POST', None, {'client_name': 'my-box'}),
                ('https://personal.example/auth/device/token', 'POST', None, {'device_code': 'dev_code_123'}),
                ('https://personal.example/auth/device/token', 'POST', None, {'device_code': 'dev_code_123'}),
                ('https://personal.example/auth/device/token', 'POST', None, {'device_code': 'dev_code_123'}),
            ])

            # --no-daemon and CI=true skip automatic daemon installation
            mock_install_daemon.reset_mock()
            with redirect_stderr(io.StringIO()):
                res_no_daemon = self.run_cli(root, 'login', 'https://personal.example', '--no-daemon')
            self.assertNotIn('daemon', res_no_daemon)
            mock_install_daemon.assert_not_called()

            with patch.dict(os.environ, {'CI': 'true'}), redirect_stderr(io.StringIO()):
                res_ci = self.run_cli(root, 'login', 'https://personal.example')
            self.assertNotIn('daemon', res_ci)
            mock_install_daemon.assert_not_called()

            # Default login fails loudly with clear fix guidance if daemon install/start fails (no silent swallow)
            with (
                patch.dict(os.environ, {'CI': ''}),
                patch.object(cli, 'install_daemon_service', side_effect=ValueError('Daemon bundle dist/daemon.mjs not found')),
                redirect_stderr(io.StringIO()),
                self.assertRaisesRegex(ValueError, 'failed to install/start local daemon.*html-preview daemon install'),
            ):
                self.run_cli(root, 'login', 'https://personal.example')

            cred_file = cli.credential_path()
            self.assertEqual(cred_file.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(cred_file.stat().st_mode & 0o777, 0o600)
            saved = cli.credentials()
            digest = hashlib.sha256(token.encode()).hexdigest()
            self.assertEqual(saved['servers']['https://personal.example']['token'], token)
            self.assertEqual(saved['identities'][digest], 'alice')
            self.assertEqual(cli.token_for('https://personal.example'), token)
            self.assertEqual(cli.user_id('https://personal.example'), 'alice')

            # HTML_PREVIEW_KEY is no longer supported and must be ignored
            with patch.dict(os.environ, {'HTML_PREVIEW_KEY': 'legacy-ignored-key'}):
                self.assertEqual(cli.token_for('https://personal.example'), token)

            # HTML_PREVIEW_TOKEN takes precedence for CI and rejects CR/LF
            with patch.dict(os.environ, {'HTML_PREVIEW_TOKEN': 'ci-override-token'}):
                self.assertEqual(cli.token_for('https://personal.example'), 'ci-override-token')
            for bad in ('bad\ntoken', 'bad\rtoken'):
                with patch.dict(os.environ, {'HTML_PREVIEW_TOKEN': bad}):
                    with self.assertRaisesRegex(ValueError, 'HTML_PREVIEW_TOKEN cannot contain line breaks'):
                        cli.token_for('https://personal.example')

    def test_login_handles_slow_down_denied_expired_and_timeout(self):
        code_payload = {
            'device_code': 'dev_code_999',
            'user_code': 'WXYZ-9999',
            'verification_uri_complete': 'https://personal.example/device?user_code=WXYZ-9999',
            'expires_in': 900,
            'interval': 5,
        }

        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp, 'HTML_PREVIEW_TOKEN': ''}):
            root = Path(tmp) / 'work'
            root.mkdir()

            # 1. slow_down increases polling interval by 2s and hostname fallback works
            sleeps, seen_names = [], []
            outcomes = ['authorization_pending', 'slow_down', 'ok']

            def slow_down_open(req, **kwargs):
                if req.full_url.endswith('/auth/device/code'):
                    seen_names.append(json.loads(req.data.decode())['client_name'])
                    return io.BytesIO(json.dumps(code_payload).encode())
                step = outcomes.pop(0)
                if step == 'ok':
                    return io.BytesIO(json.dumps({
                        'access_token': 'hp_' + 'b' * 48,
                        'token_id': 'tok_02',
                        'user': {'id': 'alice', 'login': 'alice'},
                    }).encode())
                raise urllib.error.HTTPError(
                    req.full_url, 400, 'Bad Request', {},
                    io.BytesIO(json.dumps({'error': step}).encode()),
                )

            with (
                patch.object(cli.urllib.request, 'urlopen', side_effect=slow_down_open),
                patch.object(cli.socket, 'gethostname', return_value='dev-laptop'),
                patch.object(cli.time, 'sleep', side_effect=sleeps.append),
                redirect_stderr(io.StringIO()),
            ):
                res = self.run_cli(root, 'login', 'https://personal.example', '--no-daemon')
            self.assertEqual(seen_names, ['dev-laptop'])
            self.assertEqual(sleeps, [5, 7])
            self.assertEqual(res['tokenId'], 'tok_02')

        # 2. access_denied raises ValueError and writes no credentials
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp, 'HTML_PREVIEW_TOKEN': ''}):
            root = Path(tmp) / 'work'
            root.mkdir()

            def denied_open(req, **kwargs):
                if req.full_url.endswith('/auth/device/code'):
                    return io.BytesIO(json.dumps(code_payload).encode())
                raise urllib.error.HTTPError(
                    req.full_url, 400, 'Bad Request', {},
                    io.BytesIO(json.dumps({'error': 'access_denied'}).encode()),
                )

            with (
                patch.object(cli.urllib.request, 'urlopen', side_effect=denied_open),
                patch.object(cli.time, 'sleep', side_effect=lambda _: None),
                redirect_stderr(io.StringIO()),
                self.assertRaisesRegex(ValueError, 'Device login was denied'),
            ):
                self.run_cli(root, 'login', 'https://personal.example')
            self.assertFalse(cli.credential_path().exists())

        # 3. expired_token raises ValueError and writes no credentials
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp, 'HTML_PREVIEW_TOKEN': ''}):
            root = Path(tmp) / 'work'
            root.mkdir()

            def expired_open(req, **kwargs):
                if req.full_url.endswith('/auth/device/code'):
                    return io.BytesIO(json.dumps(code_payload).encode())
                raise urllib.error.HTTPError(
                    req.full_url, 400, 'Bad Request', {},
                    io.BytesIO(json.dumps({'error': 'expired_token'}).encode()),
                )

            with (
                patch.object(cli.urllib.request, 'urlopen', side_effect=expired_open),
                patch.object(cli.time, 'sleep', side_effect=lambda _: None),
                redirect_stderr(io.StringIO()),
                self.assertRaisesRegex(ValueError, 'Device code expired; run html-preview login again'),
            ):
                self.run_cli(root, 'login', 'https://personal.example')
            self.assertFalse(cli.credential_path().exists())

        # 4. --timeout caps polling duration when authorization stays pending
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp, 'HTML_PREVIEW_TOKEN': ''}):
            root = Path(tmp) / 'work'
            root.mkdir()
            timeout_sleeps = []

            def pending_forever(req, **kwargs):
                if req.full_url.endswith('/auth/device/code'):
                    return io.BytesIO(json.dumps(code_payload).encode())
                raise urllib.error.HTTPError(
                    req.full_url, 400, 'Bad Request', {},
                    io.BytesIO(json.dumps({'error': 'authorization_pending'}).encode()),
                )

            with (
                patch.object(cli.urllib.request, 'urlopen', side_effect=pending_forever),
                patch.object(cli.time, 'sleep', side_effect=timeout_sleeps.append),
                redirect_stderr(io.StringIO()),
                self.assertRaisesRegex(ValueError, 'run html-preview login again'),
            ):
                self.run_cli(root, 'login', 'https://personal.example', '--timeout', '10')
            self.assertEqual(timeout_sleeps, [5, 5])
            self.assertFalse(cli.credential_path().exists())

    def test_logout_removes_saved_credentials_and_401_guides_to_login(self):
        self.identity.stop()
        tok_a = 'hp_' + '1' * 48
        tok_b = 'hp_' + '2' * 48
        dig_a = hashlib.sha256(tok_a.encode()).hexdigest()
        dig_b = hashlib.sha256(tok_b.encode()).hexdigest()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp, 'HTML_PREVIEW_TOKEN': ''}):
            root = Path(tmp) / 'work'
            root.mkdir()
            cli.save_credentials({
                'servers': {
                    'https://personal.example': {'token': tok_a, 'identities': {dig_a: 'alice'}},
                    'https://other.example': {'token': tok_b, 'identities': {dig_b: 'bob'}},
                },
                'https://personal.example': {'token': tok_a, 'identities': {dig_a: 'alice'}},
                'https://other.example': {'token': tok_b, 'identities': {dig_b: 'bob'}},
                'identities': {dig_a: 'alice', dig_b: 'bob'},
            })
            self.assertEqual(cli.token_for('https://personal.example'), tok_a)

            out = self.run_cli(root, 'logout', 'https://personal.example')
            self.assertEqual(out, {'ok': True, 'url': 'https://personal.example'})
            self.assertEqual(cli.token_for('https://personal.example'), '')
            self.assertEqual(cli.token_for('https://other.example'), tok_b)
            self.assertNotIn(dig_a, cli.credentials().get('identities', {}))
            self.assertEqual(cli.credentials()['identities'][dig_b], 'bob')

            with self.assertRaisesRegex(ValueError, r'Sign in with: html-preview login <URL> \(or set HTML_PREVIEW_TOKEN\)'):
                cli.user_id('https://personal.example')

            def unauthorized(req, **kwargs):
                raise urllib.error.HTTPError(req.full_url, 401, 'Unauthorized', {}, io.BytesIO(b'{"error":"Unauthorized"}'))

            with (
                patch.object(cli.urllib.request, 'urlopen', side_effect=unauthorized),
                self.assertRaisesRegex(ValueError, r'Sign in with: html-preview login <URL> \(or set HTML_PREVIEW_TOKEN\)'),
            ):
                cli.request('https://personal.example', '/api/catalog')

            # Idempotent when already logged out or credentials file missing
            cli.credential_path().unlink()
            again = self.run_cli(root, 'logout', 'https://personal.example')
            self.assertEqual(again, {'ok': True, 'url': 'https://personal.example'})

    def test_publish_scope_pin_and_order_are_removed(self):
        self.assertFalse(hasattr(cli, 'configure_key'))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            page = root / 'report.html'
            page.write_text('<h1>Plain</h1>')
            removed_invocations = [
                ('key', 'hp_test', 'https://personal.example'),
                ('key', 'hp_test'),
                ('login', '--no-open'),
                ('publish', str(page)),
                ('catalog', '--scope', 'personal'),
                ('projects', '--scope', 'personal'),
                ('versions', 'doc-1', '--scope', 'personal'),
                ('init', '--project', '产品', '--task', '报告', '--scope', 'personal'),
                ('upload', str(page), '--project', '产品', '--task', '报告', '--scope', 'personal'),
                ('upload', str(page), '--project', '产品', '--task', '报告', '--scope', 'team'),
                ('edit', str(page), '--title', '新标题', '--scope', 'personal'),
                ('delete', str(page), '--dry-run', '--scope', 'personal'),
                ('share', str(page), '--scope', 'personal'),
                ('unshare', str(page), '--scope', 'personal'),
                ('upload', str(page), '--project', '产品', '--task', '报告', '--pin'),
                ('edit', str(page), '--order', '1'),
                ('upload', str(page), '--project', '产品', '--task', '报告', '--adapter', 'claude'),
                ('upload', str(page), '--project', '产品', '--task', '报告', '--session-ref', 's1'),
                ('upload', str(page), '--project', '产品', '--task', '报告', '--adapter-meta', '{}'),
                ('upload', str(page), '--project', '产品', '--task', '报告', '--no-auto-session'),
                ('upload', str(page), '--project', '产品', '--task', '报告', '--cwd', '/tmp'),
                ('upload', str(page), '--project', '产品', '--task', '报告', '--source-file', 'a.html'),
            ]
            for argv in removed_invocations:
                with self.subTest(argv=argv), io.StringIO() as stderr, patch('sys.stderr', stderr), self.assertRaises(SystemExit) as stopped:
                    self.run_cli(root, *argv)
                self.assertEqual(stopped.exception.code, 2)

    def test_share_and_unshare_by_path_sync_config_and_preserve_on_reupload(self):
        calls, service = self.service()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=service), patch.dict(os.environ, {'HTML_PREVIEW_URL': ''}):
            root = Path(tmp)
            page = root / 'report.html'
            page.write_text('<title>周报</title><h1>v1</h1>')
            uploaded = self.run_cli(root, 'upload', str(page), '--project', '产品', '--task', '报告')
            doc_id = uploaded['id']

            shared = self.run_cli(root, 'share', str(page))
            self.assertEqual(shared['shared'], True)
            self.assertEqual(shared['shareUrl'], f'{cli.DEFAULT_URL}/s/tok-{doc_id}/')
            self.assertEqual(calls[-1][1:3], (f'/api/archives/{doc_id}/share', 'POST'))

            saved = json.loads((root / '.html-preview.json').read_text())
            binding = saved['servers'][cli.DEFAULT_URL]['members']['alice']['files']['report.html']
            self.assertEqual(binding['shareUrl'], shared['shareUrl'])

            # Subsequent upload appends v2 and preserves shareUrl in .html-preview.json
            page.write_text('<title>周报</title><h1>v2</h1>')
            v2 = self.run_cli(root, 'upload', str(page))
            self.assertEqual(v2['version'], 2)
            saved_after_v2 = json.loads((root / '.html-preview.json').read_text())
            binding_v2 = saved_after_v2['servers'][cli.DEFAULT_URL]['members']['alice']['files']['report.html']
            self.assertEqual(binding_v2['version'], 2)
            self.assertEqual(binding_v2['shareUrl'], shared['shareUrl'])

            # Unshare revokes shareUrl on server and removes shareUrl from .html-preview.json
            unshared = self.run_cli(root, 'unshare', str(page))
            self.assertEqual(unshared['shared'], False)
            self.assertIsNone(unshared['shareUrl'])
            self.assertEqual(calls[-1][1:3], (f'/api/archives/{doc_id}/share', 'DELETE'))

            saved_after_unshare = json.loads((root / '.html-preview.json').read_text())
            binding_unshared = saved_after_unshare['servers'][cli.DEFAULT_URL]['members']['alice']['files']['report.html']
            self.assertNotIn('shareUrl', binding_unshared)

    def test_share_and_unshare_by_name_and_id(self):
        calls, service = self.service()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=service), patch.dict(os.environ, {'HTML_PREVIEW_URL': ''}):
            root = Path(tmp)
            page = root / 'report.html'
            page.write_text('<h1>v1</h1>')
            uploaded = self.run_cli(root, 'upload', str(page), '--name', 'my-report', '--project', '产品', '--task', '报告')
            doc_id = uploaded['id']

            by_name = self.run_cli(root, 'share', '--name', 'my-report')
            self.assertTrue(by_name['shared'])
            self.assertEqual(calls[-1][1:3], (f'/api/archives/{doc_id}/share', 'POST'))
            saved = json.loads((root / '.html-preview.json').read_text())
            self.assertEqual(saved['servers'][cli.DEFAULT_URL]['members']['alice']['files']['report.html']['shareUrl'], by_name['shareUrl'])

            unshared_by_id = self.run_cli(root, 'unshare', '--id', doc_id)
            self.assertFalse(unshared_by_id['shared'])
            self.assertIsNone(unshared_by_id['shareUrl'])
            self.assertEqual(calls[-1][1:3], (f'/api/archives/{doc_id}/share', 'DELETE'))
            saved = json.loads((root / '.html-preview.json').read_text())
            self.assertNotIn('shareUrl', saved['servers'][cli.DEFAULT_URL]['members']['alice']['files']['report.html'])

            # Also works for remote-only pages without any local .html-preview.json
            with tempfile.TemporaryDirectory() as empty_dir:
                empty_root = Path(empty_dir)
                remote_share = self.run_cli(empty_root, 'share', '--id', 'doc-existing')
                self.assertTrue(remote_share['shared'])
                self.assertEqual(remote_share['shareUrl'], f'{cli.DEFAULT_URL}/s/tok-doc-existing/')
                self.assertFalse((empty_root / '.html-preview.json').exists())
                remote_unshare = self.run_cli(empty_root, 'unshare', '--name', 'existing-page')
                self.assertFalse(remote_unshare['shared'])
                self.assertIsNone(remote_unshare['shareUrl'])

    def test_share_and_unshare_validate_target_arguments(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            page = self.saved_page(root)
            for cmd in ('share', 'unshare'):
                with self.subTest(cmd=cmd, case='missing'):
                    with self.assertRaisesRegex(ValueError, 'Pass exactly one of a file path, --id, or --name'):
                        self.run_cli(root, cmd)
                with self.subTest(cmd=cmd, case='path_and_id'):
                    with self.assertRaisesRegex(ValueError, 'Pass exactly one of a file path, --id, or --name'):
                        self.run_cli(root, cmd, str(page), '--id', 'doc-1')
                with self.subTest(cmd=cmd, case='id_and_name'):
                    with self.assertRaisesRegex(ValueError, 'Pass exactly one of a file path, --id, or --name'):
                        self.run_cli(root, cmd, '--id', 'doc-1', '--name', 'report-page')

    def saved_page(self, root):
        page = root / 'report.html'
        page.write_text('<title>旧标题</title>')
        member = {
            'files': {
                'report.html': {
                    'id': 'doc-1',
                    'name': 'report-page',
                    'project': '产品',
                    'task': '报告',
                    'version': 1,
                },
            },
        }
        (root / '.html-preview.json').write_text(json.dumps({
            'url': cli.DEFAULT_URL,
            'servers': {cli.DEFAULT_URL: {'members': {'alice': member}}},
        }, ensure_ascii=False))
        return page

    def test_edit_keeps_the_name_and_points_the_next_upload_at_the_new_folder(self):
        calls = []
        def request(base, path, method='GET', payload=None, kind=None):
            calls.append((path, method, payload))
            if method == 'GET':
                return {'archives': [{
                    'id': 'doc-1', 'name': 'report-page', 'title': '旧标题',
                    'folder': '产品/报告',
                }]}
            if method == 'PATCH':
                return {
                    'id': 'doc-1', 'name': 'report-page', 'title': payload['title'],
                    'folder': payload['folder'], 'version': 1,
                    'url': base + '/p/report-page/', 'versionUrl': base + '/p/report-page/v1/',
                }
            params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(path).query))
            return {
                'id': 'doc-1', 'name': params['name'], 'version': 2,
                'url': base + '/p/report-page/', 'versionUrl': base + '/p/report-page/v2/',
            }
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=request), patch.dict(os.environ, {'HTML_PREVIEW_URL': ''}):
            root = Path(tmp)
            page = self.saved_page(root)
            edited = self.run_cli(root, 'edit', str(page), '--title', '新标题', '--project', '示例项目', '--task', '目录')
            self.assertEqual(edited['title'], '新标题')
            self.assertEqual(edited['folder'], '示例项目/目录')
            self.assertEqual(calls[0][0], '/api/catalog')
            self.assertEqual(calls[1][1], 'PATCH')
            self.assertEqual(calls[1][2], {'title': '新标题', 'folder': '示例项目/目录'})
            saved = json.loads((root / '.html-preview.json').read_text())
            binding = saved['servers'][cli.DEFAULT_URL]['members']['alice']['files']['report.html']
            self.assertEqual(binding['name'], 'report-page')
            self.assertEqual(binding['id'], 'doc-1')
            self.assertEqual(binding['project'], '示例项目')
            self.assertEqual(binding['task'], '目录')
            uploaded = self.run_cli(root, 'upload', str(page))
            params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(calls[-1][0]).query))
            self.assertEqual(params['name'], 'report-page')
            self.assertEqual(params['project'], '示例项目')
            self.assertEqual(params['task'], '目录')
            self.assertNotIn('scope', params)
            self.assertEqual(uploaded['version'], 2)

    def test_edit_requires_one_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.saved_page(root)
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                self.run_cli(root, 'edit', '--title', '新标题')

    def test_delete_confirms_before_removing_the_page(self):
        calls = []
        def request(base, path, method='GET', payload=None, kind=None):
            calls.append((path, method))
            return {'archives': [{
                'id': 'doc-1', 'name': 'report-page', 'title': '旧标题',
                'folder': '产品/报告', 'scope': 'personal',
            }]}
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=request), patch.dict(os.environ, {'HTML_PREVIEW_URL': ''}):
            root = Path(tmp)
            page = self.saved_page(root)
            dry = self.run_cli(root, 'delete', str(page), '--dry-run')
            self.assertEqual(dry, {
                'dryRun': True,
                'id': 'doc-1',
                'name': 'report-page',
                'title': '旧标题',
                'folder': '产品/报告',
            })
            self.assertEqual(calls, [('/api/catalog', 'GET')])
            output = io.StringIO()
            previous = Path.cwd()
            try:
                os.chdir(root)
                with patch.object(sys, 'argv', ['html-preview', 'delete', str(page)]), redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
                    cli.main()
            finally:
                os.chdir(previous)
            self.assertEqual(stopped.exception.code, 2)
            confirm = json.loads(output.getvalue())
            self.assertEqual(confirm['status'], 'needs_confirm')
            self.assertNotIn('scope', confirm)
            self.assertTrue((root / '.html-preview.json').read_text().find('doc-1') > 0)
            self.assertEqual([call[1] for call in calls], ['GET', 'GET'])
            deleted = self.run_cli(root, 'delete', str(page), '--yes')
            self.assertEqual(deleted, {'ok': True, 'id': 'doc-1', 'removed': ['report.html']})
            self.assertEqual(calls[-1], ('/api/archives/doc-1', 'DELETE'))
            saved = json.loads((root / '.html-preview.json').read_text())
            member = saved['servers'][cli.DEFAULT_URL]['members']['alice']
            self.assertNotIn('report.html', member['files'])

    def test_stateless_api_vs_daemon_required_interactive_commands(self):
        import socket as py_socket
        import threading

        calls, service = self.service()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, 'request', side_effect=service), patch.dict(os.environ, {'HTML_PREVIEW_URL': ''}):
            root = Path(tmp)
            page = root / 'report.html'
            page.write_text('<title>交互与无状态分界</title><h1>v1</h1>')

            # 1. Pure API commands (`upload` without --bind/--resolves, `projects`, `catalog`, `versions`)
            #    are completely stateless and never touch or auto-start daemon even if bundle is broken.
            with (
                patch.dict(os.environ, {
                    'HTML_PREVIEW_DAEMON_SOCK': str(root / 'absent.sock'),
                    'HTML_PREVIEW_DAEMON_BUNDLE': str(root / 'missing-daemon.mjs'),
                }),
                patch.object(cli, 'ensure_daemon_running', side_effect=AssertionError('stateless command must not require daemon')),
            ):
                v1 = self.run_cli(
                    root,
                    'upload',
                    str(page),
                    '--name',
                    'daemon-doc',
                    '--project',
                    '产品',
                    '--task',
                    '报告',
                )
                self.assertEqual(v1['version'], 1)
                params_v1 = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(calls[-1][1]).query))
                self.assertNotIn('host_id', params_v1)
                self.assertNotIn('binding', params_v1)

                projs = self.run_cli(root, 'projects')
                self.assertEqual(projs['projects'][0]['name'], '产品')
                vers = self.run_cli(root, 'versions', 'daemon-doc')
                self.assertEqual(vers['name'], 'daemon-doc')

            # 2. Interactive commands (`upload --bind`, `upload --resolves`, `bind`, `reply`, `daemon drain`)
            #    fail immediately with actionable guidance when daemon cannot start — zero silent degradation!
            calls_before_fail = len(calls)
            for failing_argv in (
                ('upload', str(page), '--bind'),
                ('upload', str(page), '--resolves', 'int_1'),
                ('bind', str(page)),
                ('reply', 'int_1', '--text', 'ok'),
                ('daemon', 'drain'),
            ):
                with (
                    self.subTest(failing_argv=failing_argv),
                    patch.dict(os.environ, {
                        'CI': 'true',  # CI=true only affects login, NEVER interactive commands!
                        'HTML_PREVIEW_DAEMON_SOCK': str(root / 'absent.sock'),
                        'HTML_PREVIEW_DAEMON_BUNDLE': str(root / 'missing-daemon.mjs'),
                    }),
                    self.assertRaisesRegex(
                        ValueError,
                        r'Local html-preview daemon is required for interactive commands and failed to start.*npm run build:daemon.*html-preview daemon start',
                    ),
                ):
                    self.run_cli(root, *failing_argv)
            self.assertEqual(len(calls), calls_before_fail)

            # 3. Interactive commands auto-start daemon when stopped (real isolated daemon.mjs!), even when CI=true
            cfg_home = root / 'isolated-cfg'
            state_home = root / 'isolated-state'
            data_home = root / 'isolated-data'
            sock_dir = Path(tempfile.mkdtemp(prefix='hp-auto-'))
            sock_path = sock_dir / 'd.sock'
            try:
                with patch.dict(os.environ, {
                    'CI': 'true',
                    'XDG_CONFIG_HOME': str(cfg_home),
                    'XDG_STATE_HOME': str(state_home),
                    'XDG_DATA_HOME': str(data_home),
                    'HTML_PREVIEW_DAEMON_SOCK': str(sock_path),
                    'HTML_PREVIEW_DAEMON_BUNDLE': '',
                    'HC_TERMINAL_ID': 't10',
                    'HTML_PREVIEW_INTERACTION_ID': 'int_env_99',
                }):
                    self.assertFalse(self.run_cli(root, 'daemon', 'status')['running'])
                    v2 = self.run_cli(root, str(page), '--resolves', 'int_1,int_2')
                    self.assertEqual(v2['version'], 2)
                    # Confirm daemon was automatically started!
                    live_status = self.run_cli(root, 'daemon', 'status')
                    self.assertTrue(live_status['running'])
                    params_v2 = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(calls[-1][1]).query))
                    self.assertEqual(params_v2['host_id'], live_status['hostId'])
                    self.assertEqual(params_v2['resolves'], 'int_env_99,int_1,int_2')

                    # Explicit `bind` backfills session onto existing archive via POST /api/archives/:id/bindings
                    bound = self.run_cli(root, 'bind', str(page), '--version', '2')
                    self.assertEqual(bound['id'], v2['id'])
                    self.assertEqual(bound['binding']['hostId'], live_status['hostId'])
                    self.assertEqual(bound['binding']['version'], 2)
                    self.assertEqual(calls[-1][1:3], (f'/api/archives/{v2["id"]}/bindings', 'POST'))

                    # `daemon drain` works against running daemon (and auto-starts if stopped)
                    self.run_cli(root, 'daemon', 'stop')
                    self.assertFalse(self.run_cli(root, 'daemon', 'status')['running'])
                    drained = self.run_cli(root, 'daemon', 'drain')
                    self.assertTrue(drained['ok'])
                    self.assertEqual(drained['hostId'], live_status['hostId'])
                    self.assertTrue(self.run_cli(root, 'daemon', 'status')['running'])
                with patch.dict(os.environ, {'HTML_PREVIEW_DAEMON_SOCK': str(sock_path)}):
                    cli.stop_daemon_process()
            finally:
                sock_path.unlink(missing_ok=True)
                try:
                    sock_dir.rmdir()
                except OSError:
                    pass

            # 4. `upload --bind` against a mock Unix socket attaches host_id, host_name, and opaque binding
            mock_sock_dir = Path(tempfile.mkdtemp(prefix='hp-mock-'))
            mock_sock_path = mock_sock_dir / 'd.sock'
            seen_daemon_reqs = []
            srv = py_socket.socket(py_socket.AF_UNIX, py_socket.SOCK_STREAM)
            srv.bind(str(mock_sock_path))
            srv.listen(4)

            def serve_mock_daemon():
                for _ in range(2):
                    conn, _ = srv.accept()
                    data = b''
                    while b'\r\n\r\n' not in data:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                    head, rest = data.split(b'\r\n\r\n', 1)
                    req_line = head.decode('utf-8').split('\r\n', 1)[0]
                    clen = 0
                    for line in head.decode('utf-8').split('\r\n'):
                        if line.lower().startswith('content-length:'):
                            clen = int(line.split(':', 1)[1].strip())
                    while len(rest) < clen:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        rest += chunk
                    if '/v1/health' in req_line:
                        resp_obj = {'ok': True, 'pid': 99999, 'hostId': 'hst_macbook000000000001', 'hostName': 'MacBook-Pro'}
                    else:
                        seen_daemon_reqs.append(json.loads(rest.decode('utf-8')))
                        resp_obj = {
                            'hostId': 'hst_macbook000000000001',
                            'hostName': 'MacBook-Pro',
                            'binding': 'hpb1.eyJ2IjoxfQ',
                        }
                    resp_json = json.dumps(resp_obj).encode('utf-8')
                    conn.sendall(
                        b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
                        + f'Content-Length: {len(resp_json)}\r\n\r\n'.encode('utf-8')
                        + resp_json
                    )
                    conn.close()

            worker = threading.Thread(target=serve_mock_daemon, daemon=True)
            worker.start()
            try:
                with patch.dict(os.environ, {'HTML_PREVIEW_DAEMON_SOCK': str(mock_sock_path)}):
                    v3 = self.run_cli(root, 'upload', str(page), '--bind')
                self.assertEqual(v3['version'], 3)
                params_v3 = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(calls[-1][1]).query))
                self.assertEqual(params_v3['host_id'], 'hst_macbook000000000001')
                self.assertEqual(params_v3['host_name'], 'MacBook-Pro')
                self.assertEqual(params_v3['binding'], 'hpb1.eyJ2IjoxfQ')
                self.assertEqual(seen_daemon_reqs[0]['sourceFile'], 'report.html')
            finally:
                worker.join(timeout=2)
                srv.close()
                mock_sock_path.unlink(missing_ok=True)
                mock_sock_dir.rmdir()

    def test_daemon_lifecycle_and_autostart_script(self):
        import subprocess as sp

        with tempfile.TemporaryDirectory() as tmp:
            cfg_home = Path(tmp) / 'cfg'
            sock_dir = Path(tempfile.mkdtemp(prefix='hp-live-'))
            sock_path = sock_dir / 'd.sock'
            work_dir = Path(tmp) / 'work'
            work_dir.mkdir(parents=True)

            autostart_script = Path(__file__).parents[1] / 'scripts' / '30-html-preview-daemon.sh'
            env_unlogged = dict(os.environ)
            env_unlogged['XDG_CONFIG_HOME'] = str(cfg_home)
            env_unlogged['XDG_DATA_HOME'] = str(Path(tmp) / 'data')
            env_unlogged['XDG_STATE_HOME'] = str(Path(tmp) / 'state')
            env_unlogged.pop('HTML_PREVIEW_TOKEN', None)
            env_unlogged['HTML_PREVIEW_DAEMON_SOCK'] = str(sock_path)
            proc = sp.run([str(autostart_script)], env=env_unlogged, capture_output=True, text=True, check=False)
            self.assertEqual(proc.returncode, 0)
            self.assertIn('skipped: not logged in', proc.stdout)

            with patch.dict(os.environ, {
                'XDG_CONFIG_HOME': str(cfg_home),
                'XDG_DATA_HOME': str(Path(tmp) / 'data'),
                'XDG_STATE_HOME': str(Path(tmp) / 'state'),
                'HTML_PREVIEW_DAEMON_SOCK': str(sock_path),
            }):
                try:
                    status_initial = self.run_cli(work_dir, 'daemon', 'status')
                    self.assertFalse(status_initial['running'])

                    installed = self.run_cli(work_dir, 'daemon', 'install', '--name', 'ci-test-box')
                    self.assertTrue(installed['ok'])
                    self.assertTrue(installed['installed'])
                    self.assertEqual(installed['hostName'], 'ci-test-box')
                    self.assertTrue(installed['hostId'].startswith('hst_'))

                    status_live = self.run_cli(work_dir, 'daemon', 'status')
                    self.assertTrue(status_live['running'])
                    self.assertEqual(status_live['hostName'], 'ci-test-box')

                    restarted = self.run_cli(work_dir, 'daemon', 'restart')
                    self.assertTrue(restarted['ok'])
                    self.assertNotEqual(restarted['pid'], installed['pid'])

                    logs_out = self.run_cli(work_dir, 'daemon', 'logs', '--lines', '20', '--json')
                    self.assertTrue(any('Daemon started' in line for line in logs_out['lines']))

                    stopped = self.run_cli(work_dir, 'daemon', 'stop')
                    self.assertTrue(stopped['stopped'])

                    status_after = self.run_cli(work_dir, 'daemon', 'status')
                    self.assertFalse(status_after['running'])

                    uninstalled = self.run_cli(work_dir, 'daemon', 'uninstall')
                    self.assertTrue(uninstalled['uninstalled'])
                finally:
                    cli.stop_daemon_process()
                    sock_path.unlink(missing_ok=True)
                    try:
                        sock_dir.rmdir()
                    except OSError:
                        pass

    def test_reply_subcommand_posts_reply_needs_attention_and_resolved(self):
        seen = []

        def open_request(req, **kwargs):
            body = json.loads(req.data.decode('utf-8')) if req.data else None
            seen.append((req.full_url, req.get_method(), req.get_header('Authorization'), body))
            return io.BytesIO(json.dumps({
                'interaction': {
                    'id': 'int_123',
                    'status': body['status'],
                    'replyText': body.get('replyText'),
                },
            }).encode('utf-8'))

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.dict(os.environ, {'HTML_PREVIEW_URL': '', 'HTML_PREVIEW_TOKEN': 'hp_test_token_123'}),
            patch.object(cli, 'ensure_daemon_running', return_value={'ok': True, 'hostId': 'hst_reply01'}) as mock_ensure_daemon,
            patch.object(cli.urllib.request, 'urlopen', side_effect=open_request),
        ):
            root = Path(tmp)

            # 1. Standard text reply
            replied = self.run_cli(root, 'reply', 'int_123', '--text', '已完成图表配色优化。')
            self.assertEqual(mock_ensure_daemon.call_count, 1)
            self.assertEqual(replied['interaction']['status'], 'replied')
            self.assertEqual(seen[-1], (
                f'{cli.DEFAULT_URL}/api/interactions/int_123/reply',
                'POST',
                'Bearer hp_test_token_123',
                {
                    'action': 'reply',
                    'replyText': '已完成图表配色优化。',
                    'status': 'replied',
                    'summary': None,
                },
            ))

            # 2. needs_attention status with summary
            attention = self.run_cli(
                root,
                'reply',
                'int_123',
                '--status',
                'needs_attention',
                '--summary',
                '等待确认接口字段',
            )
            self.assertEqual(attention['interaction']['status'], 'needs_attention')
            self.assertEqual(seen[-1][3], {
                'action': 'reply',
                'replyText': None,
                'status': 'needs_attention',
                'summary': '等待确认接口字段',
            })

            # 3. resolved status with explicit positional URL
            resolved = self.run_cli(
                root,
                'reply',
                'int_123',
                'https://selfhost.example',
                '--status',
                'resolved',
            )
            self.assertEqual(resolved['interaction']['status'], 'resolved')
            self.assertEqual(seen[-1], (
                'https://selfhost.example/api/interactions/int_123/reply',
                'POST',
                'Bearer hp_test_token_123',
                {
                    'action': 'resolve',
                    'replyText': None,
                    'status': 'resolved',
                    'summary': None,
                },
            ))

            # 4. Missing --text when status is replied raises ValueError
            with self.assertRaisesRegex(ValueError, 'Pass --text'):
                self.run_cli(root, 'reply', 'int_123')

    def test_cooperative_session_command_coordinates_os_flock_and_daemon(self):
        import fcntl
        import socket as py_socket
        import threading

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_dir = root / 'state'
            sock_dir = Path(tempfile.mkdtemp(prefix='hp-sess-'))
            sock_path = sock_dir / 'd.sock'
            fake_agy = root / 'fake-agy.py'
            report_file = root / 'child-report.json'

            fake_agy.write_text(
                '#!/usr/bin/env python3\n'
                'import fcntl, json, os, pathlib, sys, time\n'
                'lock_path = pathlib.Path(os.environ["TEST_LOCK_FILE"])\n'
                'owner_path = pathlib.Path(os.environ["TEST_OWNER_FILE"])\n'
                'for _ in range(40):\n'
                '    if owner_path.exists(): break\n'
                '    time.sleep(0.01)\n'
                'fd = os.open(str(lock_path), os.O_RDWR)\n'
                'locked = False\n'
                'try:\n'
                '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n'
                'except BlockingIOError:\n'
                '    locked = True\n'
                'finally:\n'
                '    os.close(fd)\n'
                'owner = json.loads(owner_path.read_text(encoding="utf-8"))\n'
                'pathlib.Path(os.environ["TEST_REPORT"]).write_text(json.dumps({\n'
                '    "argv": sys.argv[1:],\n'
                '    "agy_session_id": os.environ.get("AGY_SESSION_ID"),\n'
                '    "locked": locked,\n'
                '    "owner": owner,\n'
                '}), encoding="utf-8")\n',
                encoding='utf-8',
            )
            fake_agy.chmod(0o755)

            seen_paths = []
            seen_bodies = []
            srv = py_socket.socket(py_socket.AF_UNIX, py_socket.SOCK_STREAM)
            srv.bind(str(sock_path))
            srv.listen(6)

            def serve_mock_daemon():
                for _ in range(3):
                    conn, _ = srv.accept()
                    data = b''
                    while b'\r\n\r\n' not in data:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                    head, rest = data.split(b'\r\n\r\n', 1)
                    req_line = head.decode('utf-8').split('\r\n', 1)[0]
                    clen = 0
                    for line in head.decode('utf-8').split('\r\n'):
                        if line.lower().startswith('content-length:'):
                            clen = int(line.split(':', 1)[1].strip())
                    while len(rest) < clen:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        rest += chunk
                    path_part = req_line.split(' ')[1]
                    seen_paths.append(path_part)
                    seen_bodies.append(json.loads(rest.decode('utf-8')) if rest else None)
                    resp_obj = {'ok': True, 'pid': 88888, 'hostId': 'hst_coop0000000000000001', 'hostName': 'Coop-Box', 'released': True}
                    resp_json = json.dumps(resp_obj).encode('utf-8')
                    conn.sendall(
                        b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
                        + f'Content-Length: {len(resp_json)}\r\n\r\n'.encode('utf-8')
                        + resp_json
                    )
                    conn.close()

            worker = threading.Thread(target=serve_mock_daemon, daemon=True)
            worker.start()

            lock_file = state_dir / 'locks' / 'agy__conv-abc-123.lock'
            owner_file = state_dir / 'locks' / 'agy__conv-abc-123.owner.json'
            try:
                with (
                    patch.dict(os.environ, {
                        'XDG_STATE_HOME': str(state_dir.parent),
                        'HTML_PREVIEW_DAEMON_SOCK': str(sock_path),
                        'AGY_BIN': str(fake_agy),
                        'TEST_LOCK_FILE': str(lock_file),
                        'TEST_OWNER_FILE': str(owner_file),
                        'TEST_REPORT': str(report_file),
                    }),
                    patch.object(cli, 'daemon_paths', return_value={
                        'home': root,
                        'config_dir': root / 'cfg',
                        'state_dir': state_dir,
                        'data_dir': root / 'data',
                        'socket_path': sock_path,
                        'bundle_file': root / 'data' / 'daemon.mjs',
                        'runner_script': root / 'data' / 'run-daemon.sh',
                        'isolated_cfg': True,
                    }),
                    patch.object(sys, 'argv', ['html-preview', 'session', 'agy', '--conversation', 'conv-abc-123']),
                    self.assertRaises(SystemExit) as exited,
                ):
                    cli.main()

                self.assertEqual(exited.exception.code, 0)
                report = json.loads(report_file.read_text(encoding='utf-8'))
                self.assertEqual(report['argv'], ['--conversation', 'conv-abc-123'])
                self.assertEqual(report['agy_session_id'], 'conv-abc-123')
                self.assertTrue(report['locked'])
                self.assertEqual(report['owner']['adapterId'], 'agy')
                self.assertEqual(report['owner']['sessionId'], 'conv-abc-123')

                # After exit, owner file is removed and OS flock is released
                self.assertFalse(owner_file.exists())
                fd = os.open(str(lock_file), os.O_RDWR)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)

                self.assertEqual(seen_paths, ['/v1/health', '/v1/release-session', '/v1/drain'])
                self.assertEqual(seen_bodies[1], {'adapterId': 'agy', 'sessionId': 'conv-abc-123', 'waitMs': 10000})
                self.assertEqual(seen_bodies[2], {'includeDeferred': True})
            finally:
                worker.join(timeout=2)
                srv.close()
                sock_path.unlink(missing_ok=True)
                sock_dir.rmdir()

    def test_skill_only_bundle_login_and_idempotent_install(self):
        import shutil as py_shutil

        skill_src = Path(__file__).parents[1] / 'skills' / 'html-preview'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copied_skill = root / 'installed-skills' / 'html-preview'
            py_shutil.copytree(skill_src, copied_skill)
            self.assertTrue((copied_skill / 'scripts' / 'daemon.mjs').is_file())

            isolated_spec = importlib.util.spec_from_file_location(
                'html_preview_skill_only',
                copied_skill / 'scripts' / 'html-preview.py',
            )
            isolated_cli = importlib.util.module_from_spec(isolated_spec)
            isolated_spec.loader.exec_module(isolated_cli)

            cfg_home = root / 'cfg'
            state_home = root / 'state'
            data_home = root / 'data'
            work_dir = root / 'work'
            work_dir.mkdir()
            sock_dir = Path(tempfile.mkdtemp(prefix='hp-skill-'))
            sock_path = sock_dir / 'd.sock'

            def device_http(req, **kwargs):
                if req.full_url.endswith('/auth/device/code'):
                    return io.BytesIO(json.dumps({
                        'device_code': 'dev_skill_1',
                        'user_code': 'SKIL-0001',
                        'verification_uri_complete': 'https://skill.example/dashboard?device_code=SKIL-0001',
                        'expires_in': 900,
                        'interval': 1,
                    }).encode('utf-8'))
                if req.full_url.endswith('/auth/device/token'):
                    return io.BytesIO(json.dumps({
                        'access_token': 'hp_' + 'c' * 48,
                        'token_id': 'tok_skill_1',
                        'user': {'id': 'alice', 'login': 'alice'},
                    }).encode('utf-8'))
                raise AssertionError(f'Unexpected URL: {req.full_url}')

            def run_isolated(*argv):
                prev = Path.cwd()
                try:
                    os.chdir(work_dir)
                    out = io.StringIO()
                    with (
                        patch.object(sys, 'argv', ['html-preview', *argv]),
                        redirect_stdout(out),
                        redirect_stderr(io.StringIO()),
                    ):
                        isolated_cli.main()
                    return json.loads(out.getvalue())
                finally:
                    os.chdir(prev)

            try:
                with (
                    patch.dict(os.environ, {
                        'CI': '',
                        'XDG_CONFIG_HOME': str(cfg_home),
                        'XDG_STATE_HOME': str(state_home),
                        'XDG_DATA_HOME': str(data_home),
                        'HTML_PREVIEW_DAEMON_SOCK': str(sock_path),
                        'HTML_PREVIEW_DAEMON_BUNDLE': '',
                        'HTML_PREVIEW_TOKEN': '',
                    }, clear=False),
                    patch.object(isolated_cli.urllib.request, 'urlopen', side_effect=device_http),
                ):
                    # Bundle resolves directly inside the copied skill directory (no repo dist/ needed)
                    located = isolated_cli._locate_source_daemon_bundle()
                    self.assertEqual(located, (copied_skill / 'scripts' / 'daemon.mjs').resolve())

                    # 1. Fresh skill-only login installs & starts real daemon
                    login_1 = run_isolated('login', 'https://skill.example', '--name', 'Skill-Mac')
                    self.assertTrue(login_1['ok'])
                    self.assertTrue(login_1['daemon']['running'])
                    self.assertEqual(login_1['daemon']['hostName'], 'Skill-Mac')

                    status_1 = run_isolated('daemon', 'status')
                    self.assertTrue(status_1['running'])
                    pid_1 = status_1['pid']
                    self.assertIsInstance(pid_1, int)

                    # 2. Repeated `daemon install` and `login` are 100% idempotent (same PID, no second daemon)
                    install_2 = run_isolated('daemon', 'install')
                    self.assertEqual(install_2['pid'], pid_1)
                    self.assertEqual(install_2['hostName'], 'Skill-Mac')

                    install_3 = run_isolated('daemon', 'install', '--name', 'Skill-Mac-Renamed')
                    self.assertEqual(install_3['pid'], pid_1)
                    self.assertEqual(install_3['hostName'], 'Skill-Mac-Renamed')

                    login_2 = run_isolated('login', 'https://skill.example')
                    self.assertTrue(login_2['daemon']['running'])
                    self.assertEqual(login_2['daemon']['hostName'], 'Skill-Mac-Renamed')

                    status_2 = run_isolated('daemon', 'status')
                    self.assertTrue(status_2['running'])
                    self.assertEqual(status_2['pid'], pid_1)
                    self.assertEqual(status_2['hostName'], 'Skill-Mac-Renamed')
                with patch.dict(os.environ, {
                    'XDG_CONFIG_HOME': str(cfg_home),
                    'XDG_STATE_HOME': str(state_home),
                    'XDG_DATA_HOME': str(data_home),
                    'HTML_PREVIEW_DAEMON_SOCK': str(sock_path),
                }):
                    isolated_cli.stop_daemon_process()
            finally:
                sock_path.unlink(missing_ok=True)
                try:
                    sock_dir.rmdir()
                except OSError:
                    pass

    def test_concurrent_cli_start_and_install_spawn_single_daemon(self):
        import subprocess as sp

        cli_script = Path(__file__).parents[1] / 'skills' / 'html-preview' / 'scripts' / 'html-preview.py'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sock_dir = Path(tempfile.mkdtemp(prefix='hp-race-'))
            sock_path = sock_dir / 'd.sock'
            env = dict(os.environ)
            env['XDG_CONFIG_HOME'] = str(root / 'cfg')
            env['XDG_STATE_HOME'] = str(root / 'state')
            env['XDG_DATA_HOME'] = str(root / 'data')
            env['HTML_PREVIEW_DAEMON_SOCK'] = str(sock_path)
            env.pop('HTML_PREVIEW_DAEMON_BUNDLE', None)

            try:
                # 1. Five concurrent `daemon start` calls from cold stopped state
                procs = [
                    sp.Popen(
                        [sys.executable, str(cli_script), 'daemon', 'start'],
                        cwd=str(root),
                        env=env,
                        stdout=sp.PIPE,
                        stderr=sp.PIPE,
                        text=True,
                    )
                    for _ in range(5)
                ]
                outputs = [p.communicate(timeout=15) for p in procs]
                for p, (out, err) in zip(procs, outputs):
                    self.assertEqual(p.returncode, 0, msg=err)
                payloads = [json.loads(out) for out, _ in outputs]
                pids = {item['pid'] for item in payloads}
                self.assertEqual(len(pids), 1, msg=f'Expected 1 unique daemon pid, got {pids}')

                stop_res = sp.run(
                    [sys.executable, str(cli_script), 'daemon', 'stop'],
                    cwd=str(root),
                    env=env,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertTrue(json.loads(stop_res.stdout)['stopped'])

                # 2. Four concurrent `daemon install` calls from cold stopped state
                install_procs = [
                    sp.Popen(
                        [sys.executable, str(cli_script), 'daemon', 'install', '--name', 'race-box'],
                        cwd=str(root),
                        env=env,
                        stdout=sp.PIPE,
                        stderr=sp.PIPE,
                        text=True,
                    )
                    for _ in range(4)
                ]
                install_outs = [p.communicate(timeout=15) for p in install_procs]
                for p, (out, err) in zip(install_procs, install_outs):
                    self.assertEqual(p.returncode, 0, msg=err)
                install_pids = {json.loads(out)['pid'] for out, _ in install_outs}
                self.assertEqual(len(install_pids), 1, msg=f'Expected 1 unique daemon pid, got {install_pids}')
            finally:
                sp.run(
                    [sys.executable, str(cli_script), 'daemon', 'stop'],
                    cwd=str(root),
                    env=env,
                    capture_output=True,
                    check=False,
                )
                sock_path.unlink(missing_ok=True)
                try:
                    sock_dir.rmdir()
                except OSError:
                    pass

    def test_service_manager_single_authority_launchd_and_systemd(self):
        import plistlib as py_plistlib
        import subprocess as sp

        # 1. macOS launchd: consistent ProgramArguments + zero direct Popen
        with tempfile.TemporaryDirectory() as tmp:
            fake_home = Path(tmp) / 'mac-home'
            fake_home.mkdir()
            paths = {
                'home': fake_home,
                'isolated_cfg': False,
                'config_dir': fake_home / '.config' / 'html-preview',
                'state_dir': fake_home / '.local' / 'state' / 'html-preview',
                'data_dir': fake_home / '.local' / 'share' / 'html-preview',
                'host_file': fake_home / '.config' / 'html-preview' / 'host.json',
                'credentials_file': fake_home / '.config' / 'html-preview' / 'credentials.json',
                'socket_path': fake_home / '.local' / 'state' / 'html-preview' / 'daemon.sock',
                'pid_file': fake_home / '.local' / 'state' / 'html-preview' / 'daemon.pid',
                'bundle_file': fake_home / '.local' / 'share' / 'html-preview' / 'daemon.mjs',
                'runner_script': fake_home / '.local' / 'share' / 'html-preview' / 'run-daemon.sh',
                'log_file': fake_home / 'Library' / 'Logs' / 'html-preview' / 'daemon.log',
            }

            launchd_state = {'loaded': False, 'running': False, 'pid': 5100, 'calls': [], 'reloads': 0}

            def fake_launchctl_run(cmd, **kwargs):
                launchd_state['calls'].append(list(cmd))
                if cmd[:2] == ['launchctl', 'print']:
                    target = cmd[2]
                    if target.endswith('/' + cli.LAUNCHD_LABEL):
                        rc = 0 if launchd_state['loaded'] else 113
                    else:
                        rc = 0
                    return sp.CompletedProcess(cmd, rc, '', '')
                if cmd[:2] == ['launchctl', 'bootstrap']:
                    launchd_state['loaded'] = True
                    launchd_state['running'] = True
                    launchd_state['pid'] += 1
                    return sp.CompletedProcess(cmd, 0, '', '')
                if cmd[:2] == ['launchctl', 'bootout']:
                    launchd_state['loaded'] = False
                    launchd_state['running'] = False
                    return sp.CompletedProcess(cmd, 0, '', '')
                if cmd[:2] == ['launchctl', 'kickstart']:
                    if '-k' in cmd:
                        launchd_state['pid'] += 1
                    launchd_state['running'] = True
                    return sp.CompletedProcess(cmd, 0, '', '')
                if cmd[:2] == ['scutil', '--get']:
                    return sp.CompletedProcess(cmd, 0, 'Ye-MacBook-Pro\n', '')
                raise AssertionError(f'Unexpected subprocess.run on darwin: {cmd}')

            def fake_mac_health(timeout=1.5, full=False):
                if not launchd_state['running']:
                    return None
                return {
                    'ok': True,
                    'pid': launchd_state['pid'],
                    'hostId': 'hst_mac00000000000000001',
                    'hostName': 'Ye-MacBook-Pro',
                    'socketPath': str(paths['socket_path']),
                    'servers': [],
                    'availableAgents': ['codex'],
                }

            def fake_mac_sock(sock_path, method, path, payload=None, timeout=0.25):
                if path == '/v1/reload' and launchd_state['running']:
                    launchd_state['reloads'] += 1
                    return 200, {'ok': True, 'health': fake_mac_health()}
                if path == '/v1/shutdown' and launchd_state['running']:
                    launchd_state['running'] = False
                    return 200, {'ok': True, 'stopping': True}
                return None

            with (
                patch.object(cli.sys, 'platform', 'darwin'),
                patch.object(cli, 'daemon_paths', return_value=paths),
                patch.object(cli.shutil, 'which', side_effect=lambda name, path=None: f'/usr/bin/{name}'),
                patch.object(cli.subprocess, 'run', side_effect=fake_launchctl_run),
                patch.object(cli.subprocess, 'Popen', side_effect=AssertionError('CLI must not Popen when launchd is active')),
                patch.object(cli, 'probe_daemon_health', side_effect=fake_mac_health),
                patch.object(cli, '_unix_socket_json', side_effect=fake_mac_sock),
            ):
                first = cli.install_daemon_service()
                self.assertEqual(first['autostart'], 'launchd')
                self.assertEqual(first['pid'], 5101)

                plist_file = fake_home / 'Library' / 'LaunchAgents' / f'{cli.LAUNCHD_LABEL}.plist'
                plist_obj = py_plistlib.loads(plist_file.read_bytes())
                self.assertEqual(
                    plist_obj['ProgramArguments'],
                    [
                        '/usr/bin/node',
                        str(paths['bundle_file']),
                        'serve',
                        '--config-dir',
                        str(paths['config_dir']),
                        '--state-dir',
                        str(paths['state_dir']),
                        '--socket',
                        str(paths['socket_path']),
                        '--log-file',
                        str(paths['log_file']),
                    ],
                )

                # Repeating install when already loaded & unchanged reloads without bootout/bootstrap churn
                calls_before_repeat = len(launchd_state['calls'])
                second = cli.install_daemon_service()
                self.assertEqual(second['pid'], 5101)
                self.assertEqual(launchd_state['reloads'], 1)
                repeat_cmds = [c[1] for c in launchd_state['calls'][calls_before_repeat:] if c[0] == 'launchctl']
                self.assertNotIn('bootstrap', repeat_cmds)
                self.assertNotIn('bootout', repeat_cmds)

                # Stop, start, and restart all route exclusively through launchd without Popen
                cli.stop_daemon_process()
                self.assertFalse(launchd_state['running'])
                started = cli.start_daemon_process()
                self.assertTrue(launchd_state['running'])
                self.assertEqual(started['pid'], 5101)
                restarted = cli.restart_daemon_process()
                self.assertEqual(restarted['pid'], 5102)

        # 2. Linux systemd-user: consistent ExecStart + zero direct Popen
        with tempfile.TemporaryDirectory() as tmp:
            fake_home = Path(tmp) / 'linux-home'
            fake_home.mkdir()
            paths = {
                'home': fake_home,
                'isolated_cfg': False,
                'config_dir': fake_home / '.config' / 'html-preview',
                'state_dir': fake_home / '.local' / 'state' / 'html-preview',
                'data_dir': fake_home / '.local' / 'share' / 'html-preview',
                'host_file': fake_home / '.config' / 'html-preview' / 'host.json',
                'credentials_file': fake_home / '.config' / 'html-preview' / 'credentials.json',
                'socket_path': fake_home / '.local' / 'state' / 'html-preview' / 'daemon.sock',
                'pid_file': fake_home / '.local' / 'state' / 'html-preview' / 'daemon.pid',
                'bundle_file': fake_home / '.local' / 'share' / 'html-preview' / 'daemon.mjs',
                'runner_script': fake_home / '.local' / 'share' / 'html-preview' / 'run-daemon.sh',
                'log_file': fake_home / '.local' / 'state' / 'html-preview' / 'logs' / 'daemon.log',
            }

            systemd_state = {'active': False, 'pid': 6100, 'calls': [], 'reloads': 0}

            def fake_systemctl_run(cmd, **kwargs):
                systemd_state['calls'].append(list(cmd))
                if cmd[:3] == ['systemctl', '--user', 'show-environment']:
                    return sp.CompletedProcess(cmd, 0, 'PATH=/usr/bin\n', '')
                if cmd[:3] == ['systemctl', '--user', 'daemon-reload']:
                    return sp.CompletedProcess(cmd, 0, '', '')
                if cmd[:3] == ['systemctl', '--user', 'is-active']:
                    return sp.CompletedProcess(cmd, 0 if systemd_state['active'] else 3, '', '')
                if cmd[:3] == ['systemctl', '--user', 'enable']:
                    if '--now' in cmd:
                        systemd_state['active'] = True
                        systemd_state['pid'] += 1
                    return sp.CompletedProcess(cmd, 0, '', '')
                if cmd[:3] == ['systemctl', '--user', 'start']:
                    if not systemd_state['active']:
                        systemd_state['active'] = True
                        systemd_state['pid'] += 1
                    return sp.CompletedProcess(cmd, 0, '', '')
                if cmd[:3] == ['systemctl', '--user', 'restart']:
                    systemd_state['active'] = True
                    systemd_state['pid'] += 1
                    return sp.CompletedProcess(cmd, 0, '', '')
                if cmd[:3] == ['systemctl', '--user', 'stop']:
                    systemd_state['active'] = False
                    return sp.CompletedProcess(cmd, 0, '', '')
                raise AssertionError(f'Unexpected subprocess.run on linux: {cmd}')

            def fake_linux_health(timeout=1.5, full=False):
                if not systemd_state['active']:
                    return None
                return {
                    'ok': True,
                    'pid': systemd_state['pid'],
                    'hostId': 'hst_lin00000000000000001',
                    'hostName': 'linux-ws',
                    'socketPath': str(paths['socket_path']),
                    'servers': [],
                    'availableAgents': ['agy'],
                }

            def fake_linux_sock(sock_path, method, path, payload=None, timeout=0.25):
                if path == '/v1/reload' and systemd_state['active']:
                    systemd_state['reloads'] += 1
                    return 200, {'ok': True, 'health': fake_linux_health()}
                return None

            with (
                patch.object(cli.sys, 'platform', 'linux'),
                patch.dict(os.environ, {'SSH_CONNECTION': ''}, clear=False),
                patch.object(cli, 'daemon_paths', return_value=paths),
                patch.object(cli.shutil, 'which', side_effect=lambda name, path=None: f'/usr/bin/{name}'),
                patch.object(cli.subprocess, 'run', side_effect=fake_systemctl_run),
                patch.object(cli.subprocess, 'Popen', side_effect=AssertionError('CLI must not Popen when systemd-user is active')),
                patch.object(cli, 'probe_daemon_health', side_effect=fake_linux_health),
                patch.object(cli, '_unix_socket_json', side_effect=fake_linux_sock),
            ):
                first_sd = cli.install_daemon_service()
                self.assertEqual(first_sd['autostart'], 'systemd-user')
                self.assertEqual(first_sd['pid'], 6101)

                unit_file = fake_home / '.config' / 'systemd' / 'user' / cli.SYSTEMD_UNIT
                unit_text = unit_file.read_text(encoding='utf-8')
                self.assertIn(f'--config-dir" "{paths["config_dir"]}"', unit_text)
                self.assertIn(f'--state-dir" "{paths["state_dir"]}"', unit_text)
                self.assertIn(f'--socket" "{paths["socket_path"]}"', unit_text)
                self.assertIn(f'--log-file" "{paths["log_file"]}"', unit_text)

                # Idempotent repeat install
                second_sd = cli.install_daemon_service()
                self.assertEqual(second_sd['pid'], 6101)
                self.assertEqual(systemd_state['reloads'], 1)

                # Stop, start, restart via systemctl --user without Popen
                stopped_sd = cli.stop_daemon_process()
                self.assertTrue(stopped_sd['stopped'])
                self.assertFalse(systemd_state['active'])
                started_sd = cli.start_daemon_process()
                self.assertEqual(started_sd['pid'], 6102)
                restarted_sd = cli.restart_daemon_process()
                self.assertEqual(restarted_sd['pid'], 6103)


if __name__ == '__main__':
    unittest.main()
