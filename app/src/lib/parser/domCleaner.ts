import * as cheerio from 'cheerio';

export interface CleanedDomResult {
  title: string;
  cleanedHtml: string;
  learningGoals: string[];
  successCriteria: string[];
}

export class DomCleaner {
  static clean(html: string): CleanedDomResult {
    const $ = cheerio.load(html);

    // 1. Extract Title
    const pageTitle = $('title').text().trim().replace(/\s+/g, ' ');
    const h1Title = $('h1').first().text().trim();
    const title = pageTitle || h1Title || 'ILC Lesson';

    // 2. Extract Learning Goals & Success Criteria (recursively traversing all descendants)
    const learningGoals: string[] = [];
    const successCriteria: string[] = [];

    $('#ilcLearningGoals').each((_, container) => {
      let isSuccessCriteria = false;

      $(container)
        .find('h2, h3, p, ul, ol')
        .each((__, el) => {
          const text = $(el).text().trim().toLowerCase();
          if (text.includes('success criteria')) {
            isSuccessCriteria = true;
          } else if (text.includes('learning goal')) {
            isSuccessCriteria = false;
          } else if ($(el).is('ul, ol')) {
            $(el)
              .find('li')
              .each((___, li) => {
                const item = $(li).text().trim();
                if (item) {
                  if (isSuccessCriteria) {
                    successCriteria.push(item);
                  } else {
                    learningGoals.push(item);
                  }
                }
              });
          }
        });
    });

    // Replace #ilcLearningGoals with a formatted callout element in DOM
    if (learningGoals.length > 0 || successCriteria.length > 0) {
      let goalsHtml = `<div class="app-callout-goals"><h3>Learning Goals & Success Criteria</h3>`;
      if (learningGoals.length > 0) {
        goalsHtml += `<p><strong>You are learning to:</strong></p><ul>`;
        learningGoals.forEach((g) => (goalsHtml += `<li>${g}</li>`));
        goalsHtml += `</ul>`;
      }
      if (successCriteria.length > 0) {
        goalsHtml += `<p><strong>Success criteria:</strong></p><ul>`;
        successCriteria.forEach((s) => (goalsHtml += `<li>${s}</li>`));
        goalsHtml += `</ul>`;
      }
      goalsHtml += `</div>`;
      $('#ilcLearningGoals').replaceWith(goalsHtml);
    } else {
      $('#ilcLearningGoals').remove();
    }

    // 3. Process Section Banners (#mindsOn, #action, #consolidation)
    $('#mindsOn .banner').replaceWith('<h2>Minds On</h2>');
    $('#action .banner').replaceWith('<h2>Action</h2>');
    $('#consolidation .banner').replaceWith('<h2>Consolidation</h2>');

    // 4. Convert Answer Reveal Buttons into HTML <details><summary>
    $('.btn-answer-reveal').each((_, btn) => {
      const button = $(btn);
      const targetId = button.attr('id')?.replace('Button', '') || '';
      let answerDiv: any = button.next('.answer_reveal');
      if (!answerDiv.length && targetId) {
        answerDiv = $(`#${targetId}`);
      }

      const summaryText = button.text().trim() || 'Suggested Answer';
      const answerContent = answerDiv.length ? answerDiv.html() || '' : '';

      const detailsHtml = `\n<details class="suggested-answer"><summary>${summaryText}</summary>\n<div>${answerContent}</div>\n</details>\n`;
      button.replaceWith(detailsHtml);
      answerDiv.remove();
    });

    // 5. Rewrite Asset and Document Links
    $('img').each((_, img) => {
      const src = $(img).attr('src') || '';
      if (!src) return;
      if (src.startsWith('./assets/')) return;
      const filename = src.split('?')[0].split('/').pop() || '';
      if (!filename) return;

      if (/\.svg$/i.test(filename)) {
        $(img).attr('src', `./assets/icons/${filename}`);
      } else if (/\.(png|jpe?g|gif|webp)$/i.test(filename)) {
        $(img).attr('src', `./assets/img/${filename}`);
      }
    });

    $('a').each((_, link) => {
      const href = $(link).attr('href') || '';
      if (!href) return;
      if (href.startsWith('#') || href.startsWith('./assets/')) return;
      const filename = href.split('?')[0].split('/').pop() || '';
      if (href.includes('locker_docs') || /\.(pdf|docx?|xlsx?|pptx?)$/i.test(filename)) {
        $(link).attr('href', `./assets/locker_docs/${filename}`);
      }
    });

    // 6. Remove scripts, styles, noscript, and D2L navigation chrome
    $('script, style, noscript, link[rel="stylesheet"]').remove();
    $('nav, .navbar, progress, button.btn-app-drawer, button.btn-app-close, .sr-only, .hidden').remove();

    // 7. Get main content
    const mainEl = $('main#mainContent, #mainContent, .mainContent, main, body').first();
    const cleanedHtml = mainEl.length ? mainEl.html() || '' : $('body').html() || '';

    return {
      title,
      cleanedHtml,
      learningGoals,
      successCriteria
    };
  }

  /**
   * Prepares raw ILC HTML for sandboxed in-app display.
   * Lighter than clean() — preserves layout, inline styles, accordions, images.
   * Strips only: external scripts, external stylesheets, LMS nav chrome.
   */
  static preparePresentationHtml(html: string): string {
    const $ = cheerio.load(html);

    // Remove all scripts (safe — sandboxed iframe can't reach parent anyway)
    $('script').remove();

    // Rewrite stylesheet references to point to assets/css/ proxy
    $('link[rel="stylesheet"]').each((_, link) => {
      const href = $(link).attr('href') || '';
      if (!href || href.startsWith('data:') || href.startsWith('http://') || href.startsWith('https://')) return;
      const filename = href.split('?')[0].split('/').pop() || '';
      if (filename) {
        $(link).attr('href', `./assets/css/${filename}`);
      }
    });
    $('link[rel="preload"]').remove();

    // Remove D2L / ILC LMS navigation chrome
    $('nav, .navbar, .navbar-default, .d2l-navigation').remove();
    $('button.btn-app-drawer, button.btn-app-close').remove();
    $('progress').remove();

    // Rewrite asset paths to work via the /api/courses/:id/assets/ proxy
    $('img').each((_, img) => {
      const src = $(img).attr('src') || '';
      if (!src || src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) return;
      const filename = src.split('?')[0].split('#')[0].split('/').pop() || '';
      if (!filename) return;
      if (/\.svg$/i.test(filename)) {
        $(img).attr('src', `./assets/icons/${filename}`);
      } else if (/\.(png|jpe?g|gif|webp)$/i.test(filename)) {
        $(img).attr('src', `./assets/img/${filename}`);
      }
    });

    $('a').each((_, link) => {
      const href = $(link).attr('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('data:') || href.startsWith('http://') || href.startsWith('https://')) return;
      const filename = href.split('?')[0].split('#')[0].split('/').pop() || '';
      if (!filename) return;
      if (href.includes('locker_docs') || /\.(pdf|docx?|xlsx?|pptx?)$/i.test(filename)) {
        $(link).attr('href', `./assets/locker_docs/${filename}`);
      }
    });

    // Rewrite media elements (audio, video, source)
    $('source, video, audio').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (!src || src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) return;
      const filename = src.split('?')[0].split('#')[0].split('/').pop() || '';
      if (filename) {
        $(el).attr('src', `./assets/locker_docs/${filename}`);
      }
    });

    // Rewrite inline background-image styles to ./assets/**
    $('[style]').each((_, el) => {
      const style = $(el).attr('style') || '';
      if (style.includes('url(')) {
        const rewritten = style.replace(
          /url\(['"]?(?:(?:\.\.\/|\.\/)*(?:course_content\/)?(?:assets\/)?(?:img|icons)?\/)?([^'")\/\\]+\.(png|jpe?g|gif|webp|svg))['"]?\)/gi,
          (_m, file, ext) => {
            const folder = ext.toLowerCase() === 'svg' ? 'icons' : 'img';
            return `url('./assets/${folder}/${file}')`;
          }
        );
        if (rewritten !== style) {
          $(el).attr('style', rewritten);
        }
      }
    });

    // Ensure <head> exists for the base tag injected server-side at serve time
    if (!$('head').length) $('html').prepend('<head></head>');

    return $.html();
  }
}
