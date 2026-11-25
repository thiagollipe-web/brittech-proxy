// Cliente do Microsoft Edge TTS (vozes neurais, grátis, sem chave) — port
// para Node stdlib do protocolo do pacote Python edge-tts.
//
// Por que existe: o Edge TTS só fala por WebSocket, com um token
// Sec-MS-GEC que o pacote Python calcula (edge-drm.js, verificado contra
// vetores do Python). Sem dependências externas: o upgrade HTTP é feito
// com o módulo https da stdlib e os frames WebSocket são montados à mão
// (o cliente precisa mascarar os frames; o servidor responde sem máscara).
//
// Formato de saída: MP3 mono 24 kHz, 48 kbps (audio-24khz-48kbitrate-mono-mp3).
// Uma conexão por síntese (mesmo padrão do pacote Python).
'use strict';

const https = require('https');
const crypto = require('crypto');
const { generateSecMsGec, TRUSTED_CLIENT_TOKEN } = require('./edge-drm');

const WSS_HOST = 'speech.platform.bing.com';
const WSS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const SEC_MS_GEC_VERSION = '2-143.0.3650.75';
const TIMEOUT_MS = 30000;

function dateStr() {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return days[d.getUTCDay()] + ' ' + mon[d.getUTCMonth()] + ' ' + p(d.getUTCDate()) + ' ' +
    d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' +
    p(d.getUTCSeconds()) + ' GMT+0000 (Coordinated Universal Time)';
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function montarSsml(voz, texto, rate, pitch) {
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    "<voice name='" + voz + "'><prosody pitch='" + pitch + "' rate='" + rate + "' volume='+0%'>" +
    escXml(texto) + '</prosody></voice></speak>';
}

// Monta um frame WebSocket de texto (opcode 0x1), mascarado (obrigatório
// para frames do cliente).
function frameTexto(str) {
  const payload = Buffer.from(str, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0xFE;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0xFF;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function framePong(payload) {
  const mask = crypto.randomBytes(4);
  const header = Buffer.from([0x8A, 0x80 | payload.length]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Sintetiza um texto curto e devolve o MP3.
// opts: { voz, texto, rate ('+0%'), pitch ('+0st') }
// Rejeita com Error('...') em pt-BR nos casos de falha.
function sintetizar(opts) {
  const voz = opts.voz;
  const texto = opts.texto;
  const rate = opts.rate || '+0%';
  const pitch = opts.pitch || '+0st';
  return new Promise((resolve, reject) => {
    let resolvido = false;
    const concluir = (err, audio) => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(timer);
      try { if (socket) socket.destroy(); } catch (e) {}
      if (err) reject(err);
      else resolve(audio);
    };
    const timer = setTimeout(() => {
      concluir(new Error('A Microsoft demorou demais para gerar o áudio (tempo esgotado em 30 s).'));
    }, TIMEOUT_MS);

    const connId = crypto.randomUUID().replace(/-/g, '');
    const reqId = crypto.randomUUID().replace(/-/g, '');
    let gec;
    try {
      gec = generateSecMsGec();
    } catch (e) {
      concluir(new Error('Não consegui gerar o token da voz neural (' + e.message + ').'));
      return;
    }
    const url = 'wss://' + WSS_HOST + WSS_PATH +
      '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN +
      '&ConnectionId=' + connId +
      '&Sec-MS-GEC=' + gec +
      '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION;
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    let socket = null;
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        Pragma: 'no-cache', 'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    req.on('error', (e) => concluir(new Error('Não consegui conectar no serviço de voz da Microsoft (' + e.message + ').')));
    req.on('response', (res) => {
      res.resume();
      concluir(new Error('A Microsoft recusou a conexão de voz (HTTP ' + res.statusCode + ').'));
    });
    req.on('upgrade', (res, sock) => {
      socket = sock;
      let buf = Buffer.alloc(0);
      const audio = [];
      let audioBytes = 0;
      let fragOpcode = 0, fragBuf = Buffer.alloc(0);

      const enviar = (str) => { try { socket.write(frameTexto(str)); } catch (e) {} };
      const tratarMsg = (op, payload) => {
        if (op === 1) {
          const txt = payload.toString('utf8');
          if (txt.indexOf('Path:turn.end') !== -1) {
            if (audioBytes < 100) {
              concluir(new Error('A Microsoft não devolveu áudio para esse texto.'));
            } else {
              concluir(null, Buffer.concat(audio));
            }
          }
        } else if (op === 2) {
          if (payload.length < 2) return;
          // Mensagem binária do Speech SDK: 2 bytes com o tamanho do
          // cabeçalho (big-endian), o cabeçalho em texto (ex.: "Path:audio")
          // e o corpo (o áudio MP3) logo em seguida — sem bytes extras.
          // (Antes cortávamos 2 bytes a mais e decapitávamos o primeiro
          // quadro MP3 de cada pedaço: o sync FF FB sumia e o ffmpeg
          // reclamava "Header missing" em cada pedaço.)
          const hl = payload.readUInt16BE(0);
          if (2 + hl > payload.length) return;
          const hdr = payload.subarray(2, 2 + hl).toString();
          const data = payload.subarray(2 + hl);
          if (hdr.indexOf('Path:audio') !== -1 && data.length > 0) {
            audio.push(Buffer.from(data));
            audioBytes += data.length;
          }
        }
      };
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0] & 0x80) !== 0;
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 9) { try { sock.write(framePong(payload)); } catch (e) {} continue; } // ping -> pong
          if (op === 8) { sock.end(); return; } // close
          if (op === 0) {
            fragBuf = Buffer.concat([fragBuf, payload]);
            if (fin) { tratarMsg(fragOpcode, fragBuf); fragBuf = Buffer.alloc(0); }
            continue;
          }
          if (!fin) { fragOpcode = op; fragBuf = Buffer.from(payload); continue; }
          tratarMsg(op, payload);
        }
      });
      sock.on('error', (e) => concluir(new Error('A conexão de voz caiu (' + e.message + ').')));
      sock.on('close', () => {
        if (!resolvido) concluir(new Error('A conexão de voz fechou antes de terminar o áudio.'));
      });

      const ssml = montarSsml(voz, texto, rate, pitch);
      enviar('X-Timestamp:' + dateStr() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
      enviar('X-RequestId:' + reqId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + dateStr() + 'Z\r\nPath:ssml\r\n\r\n' + ssml);
    });
    req.end();
  });
}

module.exports = { sintetizar };
