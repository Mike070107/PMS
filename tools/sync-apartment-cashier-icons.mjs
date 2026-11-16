#!/usr/bin/env node
/** 费用/收款方式SVG取自Web现有定义；只更新员工收费页对应的图标规则。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const web = createRequire(new URL('../apps/neighbor-web/package.json', import.meta.url));
const ant = createRequire(web.resolve('@ant-design/icons'));
const page = read('../apps/neighbor-web/src/pages/ApartmentCashier.tsx');
const payment = read('../apps/neighbor-web/src/components/PaymentMethodIcon.tsx');
const webCss = read('../apps/neighbor-web/src/styles/apartment-cashier.css');
const target = new URL('../apps/miniapp-staff/miniprogram/pages/apartment-cashier/apartment-cashier.wxss', import.meta.url);
let css = readFileSync(target, 'utf8');
const encode = svg => `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`;
const render = node => `<${node.tag} ${Object.entries(node.attrs || {}).map(([k,v]) => `${k}="${v}"`).join(' ')}>${(node.children || []).map(render).join('')}</${node.tag}>`;
const icons = { electricity: 'ThunderboltOutlined', network: 'MobileOutlined', parking: 'CarOutlined', rent: 'HomeOutlined', management: 'ApartmentOutlined', deposit: 'CreditCardOutlined' };
for (const code of ['electricity', 'cold_water', 'hot_water', 'network', 'parking', 'rent', 'management', 'deposit']) {
  const tone = code.replaceAll('_', '-');
  const palette = webCss.match(new RegExp(`\\.${tone}\\s+i\\s*\\{\\s*color:(#[0-9a-f]+);\\s*background:(#[0-9a-f]+)`));
  if (!palette) throw Error(`Missing Web icon palette: ${code}`);
  const [, color, background] = palette;
  const svg = icons[code]
    ? render(ant(`@ant-design/icons-svg/lib/asn/${icons[code]}.js`).default.icon).replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" fill="${color}" `)
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${page.match(/function WaterDropIcon\(\).*?d="([^"]+)"/)[1]}" fill="${color}" /></svg>`;
  const rule = new RegExp(`\\.fee-icon--${code} \\{ background-color: #[0-9a-f]+; background-image: url\\("[^\\n]+?"\\)`);
  if (!rule.test(css)) throw Error(`Missing icon rule: ${code}`);
  css = css.replace(rule, `.fee-icon--${code} { background-color: ${background}; background-image: ${encode(svg)}`);
}
const marker = '/* Web同源收款方式SVG（由tools/sync-apartment-cashier-icons.mjs生成） */';
css = css.split(marker)[0].trimEnd() + '\n\n' + marker + '\n';
for (const [type, color] of Object.entries({ wechat: '#07c160', alipay: '#1677ff', cash: '#f56c6c' })) {
  const d = payment.match(new RegExp(`${type}: '([^']+)'`))[1];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${type === 'alipay' ? 448 : 576} 448"><path d="${d}" transform="translate(0 416) scale(1 -1)" fill="${color}" /></svg>`;
  css += `.payment-icon--${type} { background-image: ${encode(svg)}; }\n`;
}
writeFileSync(target, css);
console.log('Synced 8 fee icons and 3 payment icons from Web sources.');
