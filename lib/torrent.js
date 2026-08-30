const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let webtorrentPromise = null;

// webtorrent v3 is an ESM package with top-level await, so it can't be
// require()'d from this CommonJS module - load it lazily with dynamic
// import() the first time we actually need to download.
function loadWebTorrent() {
  if (!webtorrentPromise) {
    webtorrentPromise = import('webtorrent').then((m) => m.default);
  }
  return webtorrentPromise;
}

// Reads the torrent's file list (name/path/length). Using the webtorrent
// CLI's `info` command is simplest - returns parsed JSON with `files`.
function inspectTorrent(torrentPath) {
  const out = execFileSync('webtorrent', ['info', torrentPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// Downloads a single file (by index) from a .torrent using the webtorrent
// library in-process. Reports live progress through `onProgress` so the
// server can surface it to the browser:
//   { phase, fileName, length, downloaded, speed, peers, percent }
// Resolves with the list of fully-written file paths once the selected file
// has all of its pieces, then destroys the client (no post-download seeding).
async function downloadFile({ torrentPath, outDir, fileIndex, timeoutMs, onProgress }) {
  const WebTorrent = await loadWebTorrent();
  const client = new WebTorrent();

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.destroy();
      } catch (e) {
        /* already destroyed */
      }
      if (err) reject(err);
      else resolve(fs.readdirSync(outDir).map((f) => path.join(outDir, f)));
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `타임아웃 (${Math.round(timeoutMs / 1000)}초) - 트래커/피어 연결이 없거나 다운로드 속도가 너무 느립니다.`
        )
      );
    }, timeoutMs);

    client.on('error', (err) => finish(err));

    client.add(torrentPath, { path: outDir }, (torrent) => {
      let interval = null;

      const stopPolling = () => {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
      };

      const report = (phase) => {
        if (!onProgress || settled) return;
        const length = torrent.length || 0;
        const downloaded = torrent.downloaded || 0;
        onProgress({
          phase,
          fileName: target ? target.name : null,
          length,
          downloaded,
          speed: torrent.downloadSpeed || 0,
          peers: torrent.numPeers || 0,
          percent: length > 0 ? Math.min(1, downloaded / length) : 0,
        });
      };

      const target = torrent.files[fileIndex];
      if (!target) {
        torrent.destroy();
        return finish(new Error('선택할 파일을 토런트에서 찾지 못했습니다.'));
      }

      torrent.files.forEach((f) => f.deselect());
      target.select();

      torrent.on('warning', () => {
        /* individual tracker failures are noise, not fatal */
      });
      torrent.on('error', (err) => {
        stopPolling();
        finish(err);
      });
      torrent.on('done', () => {
        stopPolling();
        if (onProgress) {
          onProgress({
            phase: 'done',
            fileName: target.name,
            length: target.length,
            downloaded: target.length,
            speed: 0,
            peers: torrent.numPeers || 0,
            percent: 1,
          });
        }
        finish(null);
      });

      report('downloading');
      interval = setInterval(() => report('downloading'), 1000);
    });
  });
}

module.exports = { inspectTorrent, downloadFile };