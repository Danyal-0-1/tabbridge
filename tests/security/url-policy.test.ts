import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessUrl, redactUrl } from '../../src/core/url-policy.ts';

describe('URL policy', () => {
  it('allows only HTTP(S) and returns the URL parser canonical form', () => {
    assert.deepEqual(assessUrl('HTTP://Example.COM:80/a/../b?secret=value#section'), {
      allowed: true,
      normalized: 'http://example.com/b?secret=value#section',
    });
    assert.deepEqual(assessUrl('https://münich.example/路径'), {
      allowed: true,
      normalized: 'https://xn--mnich-kva.example/%E8%B7%AF%E5%BE%84',
    });
  });

  it('rejects privileged, executable, local, opaque, and unknown schemes', () => {
    const blocked = [
      'chrome://settings/',
      'edge://settings/',
      'brave://settings/',
      'vivaldi://settings/',
      'about:config',
      'chrome-extension://abcdefghijklmnop/page.html',
      'moz-extension://00000000-0000-4000-8000-000000000001/page.html',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/00000000-0000-4000-8000-000000000001',
      'file:///etc/passwd',
      'view-source:https://example.com/',
      'devtools://devtools/bundled/inspector.html',
      'ftp://example.com/archive',
      'ws://example.com/socket',
      'custom-handler://example/path',
    ];

    for (const value of blocked) {
      const decision = assessUrl(value);
      assert.equal(decision.allowed, false, value);
      assert.equal(decision.normalized, undefined, value);
      assert.match(decision.reason ?? '', /scheme is not allowed/);
    }
  });

  it('rejects absent, malformed, relative, and overlong input', () => {
    for (const value of [undefined, null, '', 42]) {
      assert.deepEqual(assessUrl(value), {
        allowed: false,
        reason: 'The tab has no restorable URL.',
      });
    }
    for (const value of ['not a URL', '/relative/path', 'https://[invalid']) {
      assert.deepEqual(assessUrl(value), {
        allowed: false,
        reason: 'The URL is malformed.',
      });
    }
    assert.deepEqual(assessUrl(`https://example.com/${'x'.repeat(16_365)}`), {
      allowed: false,
      reason: 'The URL exceeds the safety limit.',
    });
  });

  it('redacts credentials, query strings, and fragments from log-safe output', () => {
    assert.equal(
      redactUrl('https://user:password@example.com/private/path?token=secret#fragment'),
      'https://example.com/private/path',
    );
    assert.equal(redactUrl('definitely not a URL'), '[invalid URL]');
  });
});
