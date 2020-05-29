/* global chrome */
import { has, snakeCase } from 'lodash';
import urlParse from 'url-parse';
import qs from 'query-string';
import { encodeOps, decode } from 'steem-uri';
import operations from '@/helpers/operations.json';
import wx from 'weixin-js-sdk';

export const REQUEST_ID_PARAM = 'requestId';

export const isElectron = () => navigator.userAgent.toLowerCase().indexOf('electron') > -1;

export const isChromeExtension = () =>
  window.chrome && window.chrome.runtime && window.chrome.runtime.id;

export const isWeb = () => !isChromeExtension() && !isElectron();

export function isWeixinMiniProgram() {
  const ua = window.navigator.userAgent.toLowerCase();
  return new Promise(resolve => {
    if (ua.indexOf('micromessenger') === -1) {
      resolve(false);
    } else {
      wx.miniProgram.getEnv(res => {
        if (res.miniprogram) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    }
  });
}

function weixinNavigateBack() {
  wx.miniProgram.navigateBack();
}

function weixinSendMessage(data) {
  wx.miniProgram.postMessage({ data });
  weixinNavigateBack();
}

const rulesAndroid = [
  // Android Lollipop and Above: webview will be the same as native but it will contain "wv"
  // Android KitKat to lollipop webview will put {version}.0.0.0
  'Android.*(wv|.0.0.0)',
  // old chrome android webview agent
  'Linux; U; Android'
]
const androidWebviewRegExp = new RegExp('(' + rulesAndroid.join('|') + ')', 'ig')

const rulesIOS = [
  // iOS webview will be the same as safari but missing "Safari"
  '(iPhone|iPod|iPad)(?!.*Safari)'
]
const iOSWebviewRegExp = new RegExp('(' + rulesIOS.join('|') + ')', 'ig')

export function isAndroidWebview() {
  const ua = window.navigator.userAgent
  return !!ua.match(androidWebviewRegExp)
}

export function isIOSWebview() {
  const ua = window.navigator.userAgent
  return !!ua.match(iOSWebviewRegExp)
}

function androidSendMessage(data, method) {
  if (method && data) {
    if (android && android[method]) {
      android[method](data)
    } else {
      console.error(`android object or method ${method} is not defined`)
    }
  } else {
    console.error('method and data cannot be empty', method, data)
  }
}

function iOSSendMessage(data, method) {
  if (method && data) {
    if (webkit && webkit[method]) {
      webkit.messageHandlers[method].postMessage(data)
    } else {
      console.error(`webkit object or method ${method} is not defined`)
    }
  } else {
    console.error('method and data cannot be empty', method, data)
  }
}

export async function sendMessage(data, method) {
  const isWeixin = await isWeixinMiniProgram()
  if (isWeixin) {
    weixinSendMessage(data)
  } else if (isIOSWebview()) {
    iOSSendMessage(data, method)
  } else if (isAndroidWebview()) {
    androidSendMessage(data, method)
  } else {
    // no need to send message
  }
}

export function jsonParse(input, fallback) {
  try {
    return JSON.parse(input);
  } catch (err) {
    return fallback || {};
  }
}

/** Parse error message from Steemd response */
export function getErrorMessage(error) {
  let errorMessage = '';
  if (has(error, 'stack[0].format')) {
    errorMessage = error.stack[0].format;
    if (has(error, 'stack[0].data')) {
      const { data } = error.stack[0];
      Object.keys(data).forEach(d => {
        errorMessage = errorMessage.split(`\${${d}}`).join(data[d]);
      });
    }
  } else if (error.message) {
    errorMessage = error.message;
  }
  return errorMessage;
}

export function getVestsToSP(properties) {
  return (
    parseFloat(properties.total_vesting_fund_steem) / parseFloat(properties.total_vesting_shares)
  );
}

export function legacyUriToParsedSteemUri(uri) {
  let parsed;
  try {
    const url = urlParse(uri);
    const opName = snakeCase(url.pathname.slice(1));
    const queryParams = qs.parse(url.query.slice(1));
    if (operations[opName]) {
      const opParams = Object.keys(operations[opName].schema).reduce((acc, b) => {
        if (!queryParams[b]) return acc;
        let value = queryParams[b];
        if (operations[opName].schema[b] && operations[opName].schema[b].type) {
          if (['array', 'object'].includes(operations[opName].schema[b].type))
            value = jsonParse(value, value);
          if (operations[opName].schema[b].type === 'bool')
            value = ['true', true, 1, '1'].includes(value);
        }
        return { ...acc, [b]: value };
      }, {});
      const params = { callback: queryParams.redirect_uri };
      const b64Uri = encodeOps([[opName, opParams]], params);
      parsed = decode(b64Uri);
    }
  } catch (err) {
    console.log('Failed to parse legacy uri', err);
  }
  return parsed;
}

function processValue(schema, key, value, { vestsToSP }) {
  const { type, defaultValue } = schema[key];
  const realValue = !value && typeof defaultValue !== 'undefined' ? defaultValue : value;
  switch (type) {
    case 'amount':
      if (realValue.indexOf('VESTS') !== -1) return `${parseFloat(realValue).toFixed(6)} VESTS`;
      if (realValue.indexOf('SP') !== -1)
        return `${(parseFloat(realValue) / vestsToSP).toFixed(6)} VESTS`;
      if (realValue.indexOf('STEEM') !== -1) return `${parseFloat(realValue).toFixed(3)} STEEM`;
      if (realValue.indexOf('SBD') !== -1) return `${parseFloat(realValue).toFixed(3)} SBD`;
      return realValue;
    case 'int':
      return parseInt(realValue, 10);
    case 'bool':
      if (value === 'false' || value === false) return false;
      return realValue;
    default:
      return realValue;
  }
}

export function processTransaction(transaction, config) {
  const processed = { ...transaction };
  processed.tx.operations = transaction.tx.operations.map(([name, payload]) => {
    const processedPayload = Object.keys(operations[name].schema).reduce(
      (acc, key) => ({
        ...acc,
        [key]: processValue(operations[name].schema, key, payload[key], config),
      }),
      {},
    );
    return [name, processedPayload];
  });
  return processed;
}

export function formatNumber(number) {
  if (parseFloat(number.toFixed(6)) < 0.001) {
    return number.toFixed(6);
  }
  return number.toFixed(3);
}

export function buildSearchParams(route) {
  const keys = Object.keys(route.query);
  if (keys.length === 0) return '';
  const params = keys
    .filter(key => key !== REQUEST_ID_PARAM)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(route.query[key])}`)
    .join('&');
  return `?${params}`;
}

export function signComplete(requestId, err, res) {
  if (!isChromeExtension()) return;
  chrome.runtime.sendMessage({
    type: 'signComplete',
    payload: {
      requestId,
      args: [err, res],
    },
  });
  window.close();
}

export function isValidUrl(string) {
  try {
    // eslint-disable-next-line no-new
    new URL(string);
    return true;
  } catch (e) {
    return false;
  }
}

export function getLowestAuthorityRequired(tx) {
  let authority;
  tx.operations.forEach(operation => {
    if (operations[operation[0]] && operations[operation[0]].authority) {
      if (operations[operation[0]].authority === 'active') authority = 'active';
      if (operations[operation[0]].authority === 'posting' && authority !== 'active')
        authority = 'posting';
    }
  });
  return authority;
}

const b64uLookup = { '/': '_', _: '/', '+': '-', '-': '+', '=': '.', '.': '=' };

export const b64uEnc = str => btoa(str).replace(/(\+|\/|=)/g, m => b64uLookup[m]);

export const b64uDec = str => atob(str.replace(/(-|_|\.)/g, m => b64uLookup[m]));
