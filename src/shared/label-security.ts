import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { parse as parseCss, walk } from 'css-tree';

const tags = new Set('html head body style title main section article div span p h1 h2 h3 h4 h5 h6 br hr b strong i em small sup sub ul ol li table thead tbody tfoot tr td th colgroup col img svg g path rect circle ellipse line polyline polygon text tspan defs clipPath mask linearGradient radialGradient stop use symbol'.split(' ').map((s) => s.toLowerCase()));
const attributes = new Set('id class style lang dir role aria-label width height viewbox xmlns xmlns:xlink x y x1 y1 x2 y2 dx dy d points fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-opacity opacity transform text-anchor dominant-baseline font-family font-size font-weight preserveaspectratio rx ry cx cy r offset stop-color stop-opacity gradientunits gradienttransform clip-path mask colspan rowspan cellpadding cellspacing scope'.split(' '));
const properties = new Set('size margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left width height min-width min-height max-width max-height box-sizing border border-top border-right border-bottom border-left border-width border-style border-color border-radius display position top right bottom left overflow color background background-color background-image font font-family font-size font-weight font-style line-height letter-spacing word-spacing white-space text-align text-decoration vertical-align opacity transform transform-origin flex flex-direction align-items justify-content gap grid-template-columns grid-template-rows break-before break-after break-inside page-break-before page-break-after page-break-inside fill stroke stroke-width'.split(' '));

function invalid(): never { throw new Error('html must be self-contained and use supported HTML, SVG, and CSS only'); }
function validateCss(text: string, context: 'stylesheet' | 'declarationList'): void {
  if (text.length > 200_000) invalid();
  const ast = parseCss(text, { context, onParseError: invalid });
  walk(ast, (node) => {
    if (node.type === 'Raw' || node.type === 'Url') invalid();
    if (node.type === 'Atrule' && !['page', 'media'].includes(node.name.toLowerCase())) invalid();
    if (node.type === 'Declaration' && !properties.has(node.property.toLowerCase())) invalid();
    if (node.type === 'Function' && !['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp', 'translate', 'translatex', 'translatey', 'rotate', 'scale', 'matrix', 'linear-gradient', 'repeating-linear-gradient'].includes(node.name.toLowerCase())) invalid();
  });
}

export function validateStructuredLabel(html: string): void {
  if (!html || Buffer.byteLength(html, 'utf8') > 1_000_000) invalid();
  const root = parse(html);
  let count = 0;
  const visit = (node: DefaultTreeAdapterMap['node'], depth: number): void => {
    if (++count > 20_000 || depth > 64) invalid();
    if ('tagName' in node) {
      if (!tags.has(node.tagName.toLowerCase())) invalid();
      for (const attr of node.attrs) {
        const name = attr.name.toLowerCase();
        if (name === 'src' && node.tagName === 'img') {
          if (!/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(attr.value) || attr.value.length > 700_000) invalid();
        } else if (name === 'href' && node.tagName === 'use') {
          if (!/^#[A-Za-z0-9_-]+$/.test(attr.value)) invalid();
        } else if (!attributes.has(name)) invalid();
        if (name === 'style') validateCss(attr.value, 'declarationList');
        if (['fill', 'stroke', 'clip-path', 'mask'].includes(name) && /url\s*\(/i.test(attr.value) && !/^url\(#[A-Za-z0-9_-]+\)$/.test(attr.value)) invalid();
      }
      if (node.tagName === 'style') validateCss(node.childNodes.map((child) => 'value' in child ? child.value : '').join(''), 'stylesheet');
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, depth + 1);
  };
  visit(root, 0);
}
