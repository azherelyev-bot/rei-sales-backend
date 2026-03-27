function log(level, message, extra) {
  const ts = new Date().toISOString();
  const prefix = { info: '✓', warn: '⚠', error: '✗', debug: '·' }[level] || '·';
  console.log(`[${ts}] ${prefix} ${message}`);
  if (extra && process.env.NODE_ENV !== 'production') {
    if (extra instanceof Error) console.error(extra.stack);
    else console.log(JSON.stringify(extra, null, 2));
  }
}

module.exports = { log };
