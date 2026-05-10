const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const csstree = require('css-tree');
const path = require('path');

const app = express();
const PORT = 3000;

// CORS middleware - allow all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Analyze endpoint
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const result = await analyzeSite(url);
    res.json(result);
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: 'Failed to analyze site: ' + err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

async function analyzeSite(url) {
  // Normalize URL
  if (!url.startsWith('http')) url = 'https://' + url;

  // Fetch the page
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 15000,
    redirect: 'follow'
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const finalUrl = response.url;
  const $ = cheerio.load(html);

  // Collect all CSS (inline + external)
  let allCss = '';
  
  // Inline styles
  $('style').each((i, el) => {
    allCss += $(el).html() + '\n';
  });

  // Fetch external stylesheets
  const stylesheetUrls = [];
  $('link[rel="stylesheet"]').each((i, el) => {
    let href = $(el).attr('href');
    if (href) {
      href = new URL(href, finalUrl).href;
      stylesheetUrls.push(href);
    }
  });

  // Also check for CSS in @import or preload
  $('link[rel="preload"][as="style"]').each((i, el) => {
    let href = $(el).attr('href');
    if (href) {
      href = new URL(href, finalUrl).href;
      stylesheetUrls.push(href);
    }
  });

  // Fetch external CSS (limit to first 10 to avoid timeout)
  const cssFetches = stylesheetUrls.slice(0, 10).map(async (cssUrl) => {
    try {
      const cssResp = await fetch(cssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000
      });
      if (cssResp.ok) {
        return await cssResp.text();
      }
    } catch (e) { /* skip failed CSS */ }
    return '';
  });

  const cssResults = await Promise.all(cssFetches);
  allCss += cssResults.join('\n');

  // Parse analysis
  const analysis = {
    url: finalUrl,
    title: $('title').text().trim() || 'No title',
    meta: analyzeMeta($),
    fonts: analyzeFonts($, allCss),
    colors: analyzeColors($, allCss),
    animations: analyzeAnimations(allCss),
    transitions: analyzeTransitions(allCss),
    frameworks: detectFrameworks($, html),
    layout: analyzeLayout($, allCss),
    images: analyzeImages($, finalUrl),
    structure: analyzeStructure($),
    techStack: detectTechStack($, html, response.headers),
    icons: analyzeIcons($, finalUrl),
    responsiveness: analyzeResponsiveness($, allCss),
    shadows: analyzeShadows(allCss),
    gradients: analyzeGradients(allCss),
    borders: analyzeBorders(allCss),
  };

  return analysis;
}

function analyzeMeta($) {
  const meta = {};
  meta.description = $('meta[name="description"]').attr('content') || null;
  meta.keywords = $('meta[name="keywords"]').attr('content') || null;
  meta.author = $('meta[name="author"]').attr('content') || null;
  meta.viewport = $('meta[name="viewport"]').attr('content') || null;
  meta.charset = $('meta[charset]').attr('charset') || $('meta[http-equiv="Content-Type"]').attr('content') || null;
  meta.ogTitle = $('meta[property="og:title"]').attr('content') || null;
  meta.ogDescription = $('meta[property="og:description"]').attr('content') || null;
  meta.ogImage = $('meta[property="og:image"]').attr('content') || null;
  meta.favicon = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || null;
  return meta;
}

function analyzeFonts($, css) {
  const fonts = new Set();
  const fontDetails = [];

  // From Google Fonts links
  $('link[href*="fonts.googleapis.com"]').each((i, el) => {
    const href = $(el).attr('href');
    const familyMatch = href.match(/family=([^&:]+)/g);
    if (familyMatch) {
      familyMatch.forEach(f => {
        const name = f.replace('family=', '').replace(/\+/g, ' ');
        fonts.add(name);
        fontDetails.push({ name, source: 'Google Fonts', url: href });
      });
    }
  });

  // From CSS font-family declarations
  try {
    const ast = csstree.parse(css, { parseValue: true, parseAtrulePrelude: true });
    csstree.walk(ast, {
      visit: 'Declaration',
      enter(node) {
        if (node.property === 'font-family') {
          const value = csstree.generate(node.value);
          const families = value.split(',').map(f => f.trim().replace(/['"]/g, ''));
          families.forEach(f => {
            if (f && !['inherit', 'initial', 'unset', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace'].includes(f.toLowerCase())) {
              if (!fonts.has(f)) {
                fonts.add(f);
                fontDetails.push({ name: f, source: 'CSS Declaration' });
              }
            }
          });
        }
      }
    });
  } catch (e) { /* parse error */ }

  // From inline styles
  $('[style*="font-family"]').each((i, el) => {
    const style = $(el).attr('style');
    const match = style.match(/font-family\s*:\s*([^;]+)/i);
    if (match) {
      match[1].split(',').forEach(f => {
        f = f.trim().replace(/['"]/g, '');
        if (f && !fonts.has(f)) {
          fonts.add(f);
          fontDetails.push({ name: f, source: 'Inline Style' });
        }
      });
    }
  });

  // Check for @font-face
  try {
    const fontFaceRegex = /@font-face\s*\{[^}]*font-family\s*:\s*['"]?([^;'"}\s]+)/gi;
    let match;
    while ((match = fontFaceRegex.exec(css)) !== null) {
      const name = match[1];
      if (!fonts.has(name)) {
        fonts.add(name);
        fontDetails.push({ name, source: '@font-face (Custom)' });
      }
    }
  } catch (e) { }

  // Font sizes used
  const fontSizes = new Set();
  try {
    const ast = csstree.parse(css, { parseValue: true });
    csstree.walk(ast, {
      visit: 'Declaration',
      enter(node) {
        if (node.property === 'font-size') {
          fontSizes.add(csstree.generate(node.value));
        }
      }
    });
  } catch (e) { }

  return {
    families: fontDetails.length > 0 ? fontDetails : [{ name: 'Not detected', source: 'N/A' }],
    sizesUsed: [...fontSizes].slice(0, 20)
  };
}

function analyzeColors($, css) {
  const colors = new Set();
  const colorList = [];

  // Extract from CSS
  const colorRegex = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)|hsla?\(\s*\d+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\)/g;
  
  let match;
  const cssText = css;
  while ((match = colorRegex.exec(cssText)) !== null) {
    const color = match[0].toLowerCase();
    if (!colors.has(color) && color !== '#000' && color !== '#000000' && color !== '#fff' && color !== '#ffffff' && color !== 'rgb(0,0,0)' && color !== 'rgb(255,255,255)') {
      colors.add(color);
      colorList.push(color);
    }
  }

  // Extract from inline styles
  $('[style]').each((i, el) => {
    const style = $(el).attr('style');
    while ((match = colorRegex.exec(style)) !== null) {
      const color = match[0].toLowerCase();
      if (!colors.has(color)) {
        colors.add(color);
        colorList.push(color);
      }
    }
  });

  return colorList.slice(0, 50);
}

function analyzeAnimations(css) {
  const animations = [];

  // Find @keyframes
  const keyframeRegex = /@keyframes\s+([\w-]+)\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/g;
  let match;
  while ((match = keyframeRegex.exec(css)) !== null) {
    const name = match[1];
    const body = match[2];
    
    // Extract transforms and properties
    const transforms = [];
    const transformRegex = /transform\s*:\s*([^;]+)/g;
    let tMatch;
    while ((tMatch = transformRegex.exec(body)) !== null) {
      transforms.push(tMatch[1].trim());
    }

    animations.push({
      name,
      transforms: transforms.length > 0 ? [...new Set(transforms)] : ['(check CSS for details)'],
    });
  }

  // Find animation declarations
  const animationNames = [];
  const animDeclRegex = /(?:^|[\s;{])animation(?:-name)?\s*:\s*([^;]+)/g;
  while ((match = animDeclRegex.exec(css)) !== null) {
    const val = match[1].trim();
    const parts = val.split(/\s+/);
    // First part that's not a duration, timing, etc
    parts.forEach(p => {
      if (!/^\d/.test(p) && !['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end', 'infinite', 'alternate', 'alternate-reverse', 'normal', 'reverse', 'forwards', 'backwards', 'both', 'none', 'running', 'paused'].includes(p)) {
        if (!p.includes('(')) animationNames.push(p);
      }
    });
  }

  return {
    keyframes: animations.length > 0 ? animations : [],
    animationNames: [...new Set(animationNames)],
    totalAnimations: animations.length
  };
}

function analyzeTransitions(css) {
  const transitions = new Set();
  const regex = /transition(?:\s*)?:\s*([^;]+)/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    transitions.add(match[1].trim().substring(0, 100));
  }

  // Also check transition-property
  const propRegex = /transition-property\s*:\s*([^;]+)/g;
  while ((match = propRegex.exec(css)) !== null) {
    transitions.add('property: ' + match[1].trim());
  }

  return [...transitions].slice(0, 30);
}

function detectFrameworks($, html) {
  const detected = [];

  // React
  if (html.includes('__NEXT_DATA__') || html.includes('__next')) {
    detected.push({ name: 'Next.js', confidence: 'high', evidence: 'Found __NEXT_DATA__ or __next references' });
  } else if (html.includes('react') || $('[data-reactroot]').length || $('[data-reactid]').length || html.includes('__REACT')) {
    detected.push({ name: 'React', confidence: 'medium', evidence: 'Found React references' });
  }

  // Vue
  if (html.includes('vue') || $('[data-v-]').length || $('[v-bind]').length || html.includes('__vue__')) {
    detected.push({ name: 'Vue.js', confidence: 'medium', evidence: 'Found Vue references or directives' });
  }

  // Nuxt
  if (html.includes('__NUXT__') || html.includes('nuxt')) {
    detected.push({ name: 'Nuxt.js', confidence: 'high', evidence: 'Found __NUXT__ data' });
  }

  // Angular
  if (html.includes('ng-version') || html.includes('angular') || $('[ng-app]').length || $('[ng-controller]').length) {
    detected.push({ name: 'Angular', confidence: 'medium', evidence: 'Found Angular markers' });
  }

  // Svelte / SvelteKit
  if (html.includes('__svelte') || html.includes('svelte')) {
    detected.push({ name: 'Svelte', confidence: 'medium', evidence: 'Found Svelte references' });
  }

  // jQuery
  if (html.includes('jquery') || html.includes('jQuery')) {
    detected.push({ name: 'jQuery', confidence: 'high', evidence: 'Found jQuery references' });
  }

  // Tailwind
  if (html.includes('tailwind') || /\bclass="[^"]*(?:flex|grid|p-\d|m-\d|text-|bg-|rounded|shadow|gap-)/.test(html)) {
    const twClasses = html.match(/\b(?:flex|grid|p-\d|m-\d|text-\w+-\d+|bg-\w+-\d+|rounded-\w*|shadow-\w*|gap-\d)/g) || [];
    if (twClasses.length > 5) {
      detected.push({ name: 'Tailwind CSS', confidence: 'high', evidence: `Found ${twClasses.length} Tailwind utility classes` });
    }
  }

  // Bootstrap
  if (html.includes('bootstrap') || $('.container, .row, .col, .btn-primary, .navbar').length > 3) {
    detected.push({ name: 'Bootstrap', confidence: 'medium', evidence: 'Found Bootstrap classes or references' });
  }

  // GSAP
  if (html.includes('gsap') || html.includes('TweenMax') || html.includes('TweenLite') || html.includes('TimelineMax')) {
    detected.push({ name: 'GSAP', confidence: 'high', evidence: 'Found GSAP animation library' });
  }

  // Three.js / WebGL
  if (html.includes('three.js') || html.includes('THREE.') || html.includes('WebGLRenderer')) {
    detected.push({ name: 'Three.js', confidence: 'high', evidence: 'Found Three.js / WebGL references' });
  }

  // WordPress
  if (html.includes('wp-content') || html.includes('wordpress') || html.includes('/wp-')) {
    detected.push({ name: 'WordPress', confidence: 'high', evidence: 'Found wp-content or WordPress references' });
  }

  // Shopify
  if (html.includes('shopify') || html.includes('Shopify.theme') || html.includes('cdn.shopify.com')) {
    detected.push({ name: 'Shopify', confidence: 'high', evidence: 'Found Shopify references' });
  }

  // Webflow
  if (html.includes('webflow') || html.includes('w-') && $('[data-wf-page]').length) {
    detected.push({ name: 'Webflow', confidence: 'high', evidence: 'Found Webflow references' });
  }

  // Wix
  if (html.includes('wix') || html.includes('wixcode')) {
    detected.push({ name: 'Wix', confidence: 'high', evidence: 'Found Wix references' });
  }

  // Squarespace
  if (html.includes('squarespace') || html.includes('sqs-')) {
    detected.push({ name: 'Squarespace', confidence: 'high', evidence: 'Found Squarespace references' });
  }

  // Framer
  if (html.includes('framer') || html.includes('framer-')) {
    detected.push({ name: 'Framer', confidence: 'high', evidence: 'Found Framer references' });
  }

  // Alpine.js
  if (html.includes('alpine') || $('[x-data]').length) {
    detected.push({ name: 'Alpine.js', confidence: 'medium', evidence: 'Found Alpine.js directives' });
  }

  // HTMX
  if (html.includes('htmx') || $('[hx-get], [hx-post], [hx-swap]').length) {
    detected.push({ name: 'HTMX', confidence: 'high', evidence: 'Found HTMX attributes' });
  }

  return detected.length > 0 ? detected : [{ name: 'None detected', confidence: 'N/A', evidence: '' }];
}

function analyzeLayout($, css) {
  const layout = {};

  // Check for CSS Grid
  const gridUsages = [];
  const gridRegex = /display\s*:\s*(?:inline-)?grid/g;
  let match;
  let gridCount = 0;
  while ((match = gridRegex.exec(css)) !== null) gridCount++;
  if (gridCount > 0) gridUsages.push(`CSS Grid (${gridCount} instances)`);

  // Check grid-template
  const gridTemplateRegex = /grid-template-(?:columns|rows)\s*:\s*([^;]+)/g;
  while ((match = gridTemplateRegex.exec(css)) !== null) {
    gridUsages.push(`Template: ${match[1].trim().substring(0, 60)}`);
  }

  layout.cssGrid = gridUsages.length > 0 ? gridUsages : ['Not detected'];

  // Check for Flexbox
  const flexCount = (css.match(/display\s*:\s*(?:inline-)?flex/g) || []).length;
  layout.flexbox = flexCount > 0 ? `${flexCount} instances` : 'Not detected';

  // Positioning
  const positions = new Set();
  const posRegex = /position\s*:\s*(static|relative|absolute|fixed|sticky)/g;
  while ((match = posRegex.exec(css)) !== null) {
    positions.add(match[1]);
  }
  layout.positioning = [...positions];

  // Max widths
  const maxWidths = new Set();
  const mwRegex = /max-width\s*:\s*([^;]+)/g;
  while ((match = mwRegex.exec(css)) !== null) {
    maxWidths.add(match[1].trim());
  }
  layout.maxWidths = [...maxWidths].slice(0, 10);

  return layout;
}

function analyzeImages($, baseUrl) {
  const images = [];
  $('img').each((i, el) => {
    if (i >= 20) return;
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) {
      images.push({
        src: src.startsWith('http') ? src : new URL(src, baseUrl).href,
        alt: $(el).attr('alt') || '',
        width: $(el).attr('width') || null,
        height: $(el).attr('height') || null,
        loading: $(el).attr('loading') || 'eager',
      });
    }
  });

  // Check for lazy loading
  const lazyImages = $('[loading="lazy"]').length;
  const srcsetImages = $('[srcset]').length;

  // Background images
  const bgImages = [];
  $('[style*="background"]').each((i, el) => {
    const style = $(el).attr('style');
    const urlMatch = style.match(/url\(['"]?([^'")\s]+)['"]?\)/);
    if (urlMatch && i < 10) {
      bgImages.push(urlMatch[1]);
    }
  });

  // SVGs
  const svgCount = $('svg').length;
  const svgUse = $('use').length;

  return {
    totalImages: $('img').length,
    sampleImages: images,
    lazyLoaded: lazyImages,
    withSrcset: srcsetImages,
    backgroundImages: bgImages.slice(0, 10),
    inlineSVGs: svgCount,
    svgSymbols: svgCount > 0 ? 'Yes (inline SVGs found)' : 'No',
  };
}

function analyzeStructure($) {
  const structure = {};

  // Headings
  structure.headings = {};
  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
    const count = $(tag).length;
    if (count > 0) {
      structure.headings[tag] = {
        count,
        samples: $(tag).slice(0, 3).map((i, el) => $(el).text().trim().substring(0, 80)).get()
      };
    }
  });

  // Navigation
  structure.navigation = {
    navTags: $('nav').length,
    hasMenu: $('[class*="menu"], [class*="nav"], [id*="menu"], [id*="nav"]').length > 0,
  };

  // Main content areas
  structure.semantic = {
    header: $('header').length,
    main: $('main').length,
    section: $('section').length,
    article: $('article').length,
    aside: $('aside').length,
    footer: $('footer').length,
  };

  // Links
  structure.links = {
    total: $('a').length,
    external: $('a[href^="http"]').length,
    internal: $('a[href^="/"], a[href^="#"]').length,
  };

  // Forms
  structure.forms = {
    total: $('form').length,
    inputs: $('input').length,
    textareas: $('textarea').length,
    selects: $('select').length,
    buttons: $('button').length,
  };

  // Lists
  structure.lists = {
    unordered: $('ul').length,
    ordered: $('ol').length,
  };

  // Tables
  structure.tables = $('table').length;

  // Videos & Audio
  structure.media = {
    video: $('video').length + $('iframe[src*="youtube"], iframe[src*="vimeo"]').length,
    audio: $('audio').length,
  };

  return structure;
}

function detectTechStack($, html, headers) {
  const stack = [];

  // CMS detection
  if (html.includes('wp-content') || html.includes('wordpress')) stack.push('WordPress');
  if (html.includes('drupal')) stack.push('Drupal');
  if (html.includes('joomla')) stack.push('Joomla');
  if (html.includes('shopify')) stack.push('Shopify');
  if (html.includes('squarespace')) stack.push('Squarespace');
  if (html.includes('wix.com') || html.includes('wixstatic.com')) stack.push('Wix');
  if (html.includes('webflow.com')) stack.push('Webflow');
  if (html.includes('framer')) stack.push('Framer');

  // Analytics
  if (html.includes('google-analytics') || html.includes('gtag') || html.includes('GA_MEASUREMENT_ID') || html.includes('googletagmanager')) stack.push('Google Analytics / GTM');
  if (html.includes('hotjar')) stack.push('Hotjar');
  if (html.includes('segment.com') || html.includes('analytics.segment')) stack.push('Segment');
  if (html.includes('plausible')) stack.push('Plausible Analytics');
  if (html.includes('mixpanel')) stack.push('Mixpanel');
  if (html.includes('amplitude')) stack.push('Amplitude');

  // CDN / Hosting
  const server = headers.get('server');
  if (server) stack.push(`Server: ${server}`);
  if (html.includes('cloudflare')) stack.push('Cloudflare');
  if (html.includes('cloudfront')) stack.push('AWS CloudFront');
  if (html.includes('vercel')) stack.push('Vercel');
  if (html.includes('netlify')) stack.push('Netlify');
  if (html.includes('fastly')) stack.push('Fastly');

  // Payment
  if (html.includes('stripe')) stack.push('Stripe');
  if (html.includes('paypal')) stack.push('PayPal');
  if (html.includes('square')) stack.push('Square');

  // Chat
  if (html.includes('intercom')) stack.push('Intercom');
  if (html.includes('crisp')) stack.push('Crisp');
  if (html.includes('drift')) stack.push('Drift');
  if (html.includes('zendesk')) stack.push('Zendesk');
  if (html.includes('tawk.to')) stack.push('Tawk.to');

  // A/B Testing
  if (html.includes('optimizely')) stack.push('Optimizely');
  if (html.includes('vwo') || html.includes('visualwebsiteoptimizer')) stack.push('VWO');
  if (html.includes('google.optimize')) stack.push('Google Optimize');

  return stack.length > 0 ? [...new Set(stack)] : ['None detected'];
}

function analyzeIcons($, baseUrl) {
  const icons = [];

  // Favicon
  const favicon = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href');
  if (favicon) icons.push({ type: 'favicon', src: favicon });

  // Apple touch icons
  $('link[rel="apple-touch-icon"]').each((i, el) => {
    icons.push({ type: 'apple-touch-icon', src: $(el).attr('href'), sizes: $(el).attr('sizes') });
  });

  // Font Awesome
  const faLinks = $('link[href*="font-awesome"], link[href*="fontawesome"]');
  if (faLinks.length) icons.push({ type: 'Font Awesome', source: 'External CSS' });

  // Material Icons
  if ($('link[href*="material"]').length || $('link[href*="material-icons"]').length) {
    icons.push({ type: 'Material Icons', source: 'External CSS' });
  }

  // Icon fonts from CSS classes
  const iconClasses = $('[class*="icon"], [class*="fa-"], [class*="material-icons"]').length;
  
  // SVG icons
  const svgIcons = $('svg').length;

  return {
    icons,
    iconFontClasses: iconClasses,
    inlineSVGs: svgIcons,
  };
}

function analyzeResponsiveness($, css) {
  const breakpoints = new Set();
  const regex = /@media[^{]*\((?:min|max)-width\s*:\s*(\d+px)\)/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    breakpoints.add(match[1]);
  }

  // Also catch @media without parentheses
  const regex2 = /@media[^{]*?(\d+)px/g;
  while ((match = regex2.exec(css)) !== null) {
    breakpoints.add(match[1] + 'px');
  }

  const hasViewport = !!$('meta[name="viewport"]').length;

  return {
    hasViewportMeta: hasViewport,
    viewportContent: $('meta[name="viewport"]').attr('content') || null,
    breakpoints: [...breakpoints].sort((a, b) => parseInt(a) - parseInt(b)),
    mediaQueryCount: (css.match(/@media/g) || []).length,
  };
}

function analyzeShadows(css) {
  const shadows = new Set();
  const regex = /(?:box-shadow|text-shadow)\s*:\s*([^;]+)/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    shadows.add(match[0].trim().substring(0, 100));
  }
  return [...shadows].slice(0, 20);
}

function analyzeGradients(css) {
  const gradients = new Set();
  const regex = /(?:background|background-image)\s*:\s*([^;]*(?:linear-gradient|radial-gradient|conic-gradient)[^;]*)/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    gradients.add(match[1].trim().substring(0, 150));
  }
  return [...gradients].slice(0, 15);
}

function analyzeBorders(css) {
  const borders = new Set();
  const regex = /border(?:-\w+)?\s*:\s*([^;]+)/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    borders.add(match[0].trim().substring(0, 100));
  }
  return [...borders].slice(0, 15);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔍 Site Analyzer running at http://localhost:${PORT}`);
  console.log(`📡 API endpoint: http://localhost:${PORT}/api/analyze`);
});
