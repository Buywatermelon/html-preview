import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';

const base = (process.env.HTML_PREVIEW_URL || 'https://html.1997117.xyz').replace(/\/+$/, '');
let token = process.env.HTML_PREVIEW_TOKEN || '';
if (!token) {
  try {
    const credPath = (process.env.XDG_CONFIG_HOME || homedir() + '/.config') + '/html-preview/credentials.json';
    const settings = JSON.parse(await readFile(credPath, 'utf8'));
    token = settings?.servers?.[base]?.token || settings?.[base]?.token || '';
  } catch {}
}
assert.ok(token, 'Sign in first: html-preview login ' + base + ' (or set HTML_PREVIEW_TOKEN)');

async function request(path, method = 'GET', body, type = 'application/json') {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body !== undefined ? {'Content-Type': type} : {}),
    },
    body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
  });
  assert.ok(response.ok, 'Request failed: ' + response.status);
  return response.json();
}

async function page(url) {
  const response = await fetch(url + '?bar=0', {headers: {Authorization: 'Bearer ' + token}});
  assert.ok(response.ok, 'Page fetch failed: ' + response.status);
  return response.text();
}

let doc = null;
try {
  const name = 'smoke-' + crypto.randomUUID();
  const query = new URLSearchParams({name, project: 'html-preview', task: '验收'}).toString();
  const first = await request('/upload?' + query, 'POST', '<h1>v1</h1>', 'text/html');
  doc = first;
  assert.equal(first.version, 1);
  assert.equal(first.shared, false);
  assert.equal(first.shareUrl, null);
  assert.equal(await page(first.versionUrl), '<h1>v1</h1>');
  assert.equal(await page(first.url), '<h1>v1</h1>');

  // Unauthenticated access to private /p/... must not return 200 direct HTML
  const unauthPrivate = await fetch(first.url + '?bar=0', {redirect: 'manual'});
  assert.equal(unauthPrivate.ok, false, 'Private preview must reject unauthenticated direct access');

  // Enable public share link and verify anonymous access + CSP opaque-origin sandbox
  const shared = await request('/api/archives/' + first.id + '/share', 'POST');
  assert.equal(shared.shared, true);
  assert.ok(shared.shareUrl && shared.shareUrl.includes('/s/'));

  const publicV1 = await fetch(shared.shareUrl, {redirect: 'manual'});
  assert.equal(publicV1.status, 200);
  const csp = publicV1.headers.get('content-security-policy') || '';
  assert.ok(csp.includes('sandbox'), 'Public share response must carry CSP sandbox header');
  assert.ok(!csp.includes('allow-same-origin'), 'Public share CSP sandbox must not allow-same-origin');
  assert.equal(await publicV1.text(), '<h1>v1</h1>');

  // Append v2: fixed v1 stays v1, latest private url & public shareUrl serve v2
  const second = await request('/upload?' + query, 'POST', '<h1>v2</h1>', 'text/html');
  assert.equal(second.id, first.id);
  assert.equal(second.version, 2);
  assert.equal(second.shared, true);
  assert.equal(second.shareUrl, shared.shareUrl);
  assert.equal(await page(first.versionUrl), '<h1>v1</h1>');
  assert.equal(await page(second.versionUrl), '<h1>v2</h1>');
  assert.equal(await page(second.url), '<h1>v2</h1>');

  const publicV2 = await fetch(shared.shareUrl, {redirect: 'manual'});
  assert.equal(publicV2.status, 200);
  assert.equal(await publicV2.text(), '<h1>v2</h1>');

  // Revoke public share: shareUrl immediately returns 404
  const unshared = await request('/api/archives/' + first.id + '/share', 'DELETE');
  assert.equal(unshared.shared, false);
  assert.equal(unshared.shareUrl, null);
  const afterUnshare = await fetch(shared.shareUrl, {redirect: 'manual'});
  assert.equal(afterUnshare.status, 404);

  // Delete personal document and verify cleanup
  await request('/api/archives/' + first.id, 'DELETE');
  doc = null;
  const deletedResponse = await fetch(second.url + '?bar=0', {headers: {Authorization: 'Bearer ' + token}});
  assert.equal(deletedResponse.status, 404);
  console.log(JSON.stringify({result: 'PASS', versions: 2, publicShareVerified: true, sandboxVerified: true, deleted: true}));
} finally {
  if (doc) await request('/api/archives/' + doc.id, 'DELETE');
}
