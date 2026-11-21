'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var fs = require('node:fs');
var net = require('node:net');
var os = require('node:os');
var path = require('node:path');

var pricing = require('../lib/pricing');
var invoice = require('../lib/invoice');
var reports = require('../lib/reports');

test('invoice uses the billed HSN GST slab and split', function () {
  var order = {
    id: 1,
    items: [{ id: 1, name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 100, qty: 1 }]
  };

  var billed = pricing.computeTotals(order.items, '');
  var invoiced = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { tax: invoiced.tax, cgst: invoiced.cgst, sgst: invoiced.sgst, total: invoiced.total, gstPercent: invoiced.rows[0].gstPercent },
    { tax: billed.tax, cgst: billed.cgst, sgst: billed.sgst, total: billed.total, gstPercent: 12 }
  );
});

test('invoice taxes after the flat coupon discount', function () {
  var order = {
    id: 2,
    coupon: 'FLAT50',
    items: [{ id: 2, name: 'Rice', sku: 'RICE', hsn: '1006', price: 600, qty: 1 }]
  };

  var billed = pricing.computeTotals(order.items, order.coupon);
  var invoiced = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { discount: billed.discount, tax: billed.tax, total: billed.total },
    { discount: 50, tax: 27.5, total: 577.5 }
  );
  assert.deepEqual(
    { discount: invoiced.discount, tax: invoiced.tax, total: invoiced.total, lineTax: invoiced.rows[0].lineTax },
    { discount: billed.discount, tax: billed.tax, total: billed.total, lineTax: 27.5 }
  );
});

test('invoice applies the same capped percent coupon as order pricing', function () {
  var order = {
    id: 3,
    coupon: 'SAVE10',
    items: [{ id: 3, name: 'Rice', hsn: '1006', price: 3000, qty: 1 }]
  };

  var billed = pricing.computeTotals(order.items, order.coupon);
  var invoiced = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { discount: billed.discount, tax: billed.tax, total: billed.total },
    { discount: 150, tax: 142.5, total: 2992.5 }
  );
  assert.deepEqual(
    { discount: invoiced.discount, tax: invoiced.tax, total: invoiced.total },
    { discount: billed.discount, tax: billed.tax, total: billed.total }
  );
});

test('invoice does not apply an inactive coupon', function () {
  var order = {
    id: 4,
    coupon: 'DIWALI20',
    items: [{ id: 4, name: 'Rice', hsn: '1006', price: 1200, qty: 1 }]
  };

  var billed = pricing.computeTotals(order.items, order.coupon);
  var invoiced = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { discount: billed.discount, total: billed.total },
    { discount: 0, total: 1260 }
  );
  assert.deepEqual(
    { discount: invoiced.discount, total: invoiced.total },
    { discount: billed.discount, total: billed.total }
  );
});

test('GST reconciliation reports matching invoice and billed totals', function () {
  var order = {
    id: 5,
    date: '21/11/2026',
    customer: 'Test Customer',
    coupon: 'FLAT50',
    status: 'completed',
    items: [{ id: 5, name: 'Rice', sku: 'RICE', hsn: '1006', price: 600, qty: 1 }],
    subtotal: 600,
    discount: 50,
    tax: 27.5,
    total: 577.5
  };

  var result = reports.getGstReconciliation({ orders: [order] });

  assert.equal(result.totalChecked, 1);
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.totalDelta, 0);
  assert.deepEqual(
    { ledgerTax: result.rows[0].ledgerTax, invoiceTax: result.rows[0].invoiceTax, ledgerTotal: result.rows[0].ledgerTotal, invoiceTotal: result.rows[0].invoiceTotal, delta: result.rows[0].delta, matched: result.rows[0].matched },
    { ledgerTax: 27.5, invoiceTax: 27.5, ledgerTotal: 577.5, invoiceTotal: 577.5, delta: 0, matched: true }
  );
});

test('running app invoice matches the completed order bill', async function () {
  var repo = path.resolve(__dirname, '..');
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopledger-invoice-'));
  var port = await new Promise(function (resolve, reject) {
    var server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      var selected = server.address().port;
      server.close(function () { resolve(selected); });
    });
  });
  var app;

  try {
    fs.cpSync(repo, temp, {
      recursive: true,
      filter: function (source) {
        var relative = path.relative(repo, source);
        return relative === '' || !['.git', 'node_modules', 'docs', 'test'].includes(relative.split(path.sep)[0]);
      }
    });

    app = childProcess.spawn(process.execPath, ['server.js'], {
      cwd: temp,
      env: Object.assign({}, process.env, {
        PORT: String(port),
        NODE_PATH: path.join(repo, 'node_modules') + path.delimiter + (process.env.NODE_PATH || '')
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    var stdout = '';
    var stderr = '';
    app.stdout.setEncoding('utf8');
    app.stdout.on('data', function (chunk) { stdout += chunk; });
    app.stderr.setEncoding('utf8');
    app.stderr.on('data', function (chunk) { stderr += chunk; });

    var ready = false;
    var lastError = '';
    for (var attempt = 0; attempt < 80; attempt++) {
      if (app.exitCode !== null) throw new Error('Temporary server exited: ' + stdout + stderr);
      try {
        var response = await fetch('http://localhost:' + port + '/api/products');
        if (response.ok) { ready = true; break; }
      } catch (error) { lastError = error.message + (error.cause ? ' (' + error.cause.code + ' ' + error.cause.address + ':' + error.cause.port + ')' : ''); }
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    assert.equal(ready, true, 'temporary copy server should start: ' + stdout + stderr + ' ' + lastError);

    var placed = await fetch('http://localhost:' + port + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 1, qty: 1 }], coupon: 'SAVE10' })
    });
    assert.equal(placed.status, 201);
    var order = await placed.json();
    assert.deepEqual(
      { subtotal: order.subtotal, discount: order.discount, tax: order.tax, total: order.total },
      { subtotal: 640, discount: 64, tax: 28.8, total: 604.8 }
    );

    var invoiceResponse = await fetch('http://localhost:' + port + '/orders/' + order.id + '/invoice');
    var html = await invoiceResponse.text();
    assert.match(html, /Invoice Total<\/td><td class="r">[^<]*604\.80/);
    assert.match(html, />5%<\/td><td class="r">[^<]*28\.80/);
    assert.match(html, /<td>CGST<\/td><td class="r">[^<]*14\.40/);
    assert.match(html, /<td>SGST<\/td><td class="r">[^<]*14\.40/);
  } finally {
    if (app && app.exitCode === null) {
      app.kill();
      await new Promise(function (resolve) { app.once('exit', resolve); });
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
