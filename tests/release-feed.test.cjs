/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Test the release feed with Node's test runner. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { findUpdate, parseReleaseFeed, releaseAssetName, releaseAssetUrl } = require('../src/main/updater/releaseFeed.ts')

const REPOSITORY = 'Lun13371/SynteeAgentDesktop'

function asset(version, platform) {
  return {
    browser_download_url: releaseAssetUrl(version, platform),
    size: platform === 'win32' ? 300_000_000 : 250_000_000,
    digest: 'sha256:' + (platform === 'win32' ? 'a' : 'b').repeat(64),
    state: 'uploaded',
  }
}

function release(version, patch = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    body: `Changes in ${version}`,
    published_at: '2026-11-17T12:00:00Z',
    assets: [asset(version, 'win32'), asset(version, 'linux')],
    ...patch,
  }
}

test('asset names and URLs match what the release workflow publishes', () => {
  assert.equal(releaseAssetName('1.1.5', 'win32'), 'Syntee-Helper-Setup-1.1.5-x64.exe')
  assert.equal(releaseAssetName('1.1.5', 'linux'), 'syntee-helper-1.1.5-x86_64.tar.zst')
  assert.equal(
    releaseAssetUrl('1.1.5', 'win32'),
    `https://github.com/${REPOSITORY}/releases/download/v1.1.5/Syntee-Helper-Setup-1.1.5-x64.exe`,
  )
  assert.equal(
    releaseAssetUrl('1.1.5', 'linux'),
    `https://github.com/${REPOSITORY}/releases/download/v1.1.5/syntee-helper-1.1.5-x86_64.tar.zst`,
  )
  assert.equal(releaseAssetUrl('1.1.5/../../file', 'win32'), null)
})

test('one release yields one manifest per platform with the right delivery', () => {
  const feed = parseReleaseFeed([release('1.1.5')])
  assert.equal(feed.length, 2)

  const windows = feed.find(entry => entry.platform === 'win32')
  assert.equal(windows.delivery, 'installer')
  assert.equal(windows.version, '1.1.5')
  assert.equal(windows.sha256, 'a'.repeat(64))
  assert.equal(windows.changelog, 'Changes in 1.1.5')

  const linux = feed.find(entry => entry.platform === 'linux')
  assert.equal(linux.delivery, 'archive')
  assert.equal(linux.sha256, 'b'.repeat(64))
})

test('feed sorts numerically and only offers versions newer than the installed one', () => {
  const feed = parseReleaseFeed([release('1.2.0'), release('1.10.0'), release('1.1.5')])
  const versions = feed.filter(entry => entry.platform === 'win32').map(entry => entry.version)
  assert.deepEqual(versions, ['1.10.0', '1.2.0', '1.1.5'])

  assert.equal(findUpdate(feed, '1.2.1', 'win32').version, '1.10.0')
  assert.equal(findUpdate(feed, '1.10.0', 'win32'), null)
  assert.equal(findUpdate(feed, '2.0.0', 'win32'), null)
  assert.equal(findUpdate(feed, '1.2.1', 'linux').version, '1.10.0')
})

test('feed ignores drafts, foreign tags, malformed versions and untrusted assets', () => {
  const wrongHost = release('9.0.0')
  wrongHost.assets[0].browser_download_url = 'https://example.org/setup.exe'
  const noDigest = release('8.0.0')
  delete noDigest.assets[0].digest
  const zeroSize = release('7.0.0')
  zeroSize.assets[0].size = 0
  const notUploaded = release('6.0.0')
  notUploaded.assets[0].state = 'new'

  const feed = parseReleaseFeed([
    release('10.0.0', { tag_name: 'arch-v10.0.0-1' }),
    release('11.0.0', { tag_name: 'windows-v11.0.0' }),
    release('12.0.0', { draft: true }),
    release('12.1.0', { prerelease: true }),
    release('13.0.0-beta'),
    release('14.0.0.1'),
    wrongHost, noDigest, zeroSize, notUploaded,
    release('1.1.5'),
  ])

  assert.deepEqual(
    feed.filter(entry => entry.platform === 'win32').map(entry => entry.version),
    ['1.1.5'],
  )
})

test('a release with only the Windows asset still serves Linux from another tag', () => {
  const windowsOnly = release('1.2.0')
  windowsOnly.assets = [asset('1.2.0', 'win32')]
  const feed = parseReleaseFeed([windowsOnly, release('1.1.5')])

  assert.equal(findUpdate(feed, '1.0.0', 'win32').version, '1.2.0')
  // Linux не видит 1.2.0 (нет ассета) и остаётся на 1.1.5.
  assert.equal(findUpdate(feed, '1.0.0', 'linux').version, '1.1.5')
})
