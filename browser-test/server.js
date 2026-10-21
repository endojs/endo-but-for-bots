// @ts-check
const path = require('path');
const http = require('http');
const fs = require('fs');

const repositoryRoot = path.join(__dirname, '..');
const packagesRoot = path.join(repositoryRoot, 'packages');

const server = http.createServer((req, res) => {
  console.log(req.url);

  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><script src="ses.umd.js"></script>');
  }
  if (req.url === '/ses.umd.js') {
    res.writeHead(200, {
      // MUST HAVE for SES to work: charset=utf-8
      'Content-Type': 'text/javascript; charset=utf-8',
    });
    return res.end(
      fs.readFileSync(
        path.join(packagesRoot, 'ses', 'dist', 'ses.umd.js'),
        'utf-8',
      ),
    );
  }

  const pathname = decodeURIComponent(
    new URL(req.url || '/', 'http://127.0.0.1').pathname,
  );
  if (pathname.startsWith('/packages/') && pathname.endsWith('.js')) {
    const filename = path.resolve(repositoryRoot, `.${pathname}`);
    if (filename.startsWith(`${packagesRoot}${path.sep}`)) {
      try {
        const source = fs.readFileSync(filename, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
        });
        return res.end(source);
      } catch (error) {
        const { code } = /** @type {NodeJS.ErrnoException} */ (error);
        if (code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  console.warn('404', req.url);
  res.writeHead(404);
  res.end();

  return undefined;
});

server.listen({ host: '127.0.0.1', port: 3000 });
