import { describe, it, expect } from 'bun:test';
import { stripLessonMedia } from './stripMedia';

describe('stripLessonMedia', () => {
  it('strips user prompt specific example image references', () => {
    const input = `
Here are the public services images:
![Canadian soldiers on duty in Afghanistan|50%](./assets/img/clu3m_4.3.1a.jpg) 
![OPP cruiser|50%](./assets/img/clu3m_4.3.1b.jpg) 
![Ottawa's O-Train|50%](./assets/img/clu3m_4.3.1c.jpg) 
![Canadian currency|50%](./assets/img/clu3m_4.3.1d.jpg) 
![Neys Provincial Park, on the shores of Lake Superior|50%](./assets/img/clu3m_4.3.1e.jpg) 
![A garbage truck, operating in the City of Toronto|50%](./assets/img/clu3m_4.3.1f.jpg) 

Review each image above to answer the questions.
`;
    const result = stripLessonMedia(input);
    expect(result).not.toContain('clu3m_4.3.1a.jpg');
    expect(result).not.toContain('clu3m_4.3.1b.jpg');
    expect(result).not.toContain('clu3m_4.3.1c.jpg');
    expect(result).not.toContain('clu3m_4.3.1d.jpg');
    expect(result).not.toContain('clu3m_4.3.1e.jpg');
    expect(result).not.toContain('clu3m_4.3.1f.jpg');
    expect(result).not.toContain('![Canadian soldiers');
    expect(result).not.toContain('./assets/img');
    expect(result).toBe(
      `Here are the public services images:\n\nReview each image above to answer the questions.`
    );
  });

  it('strips plain markdown images, obsidian sizing, and pandoc attributes', () => {
    const input = `
# Title
![Standard image](./assets/img/test1.png)
![Obsidian width|300](./assets/img/test2.png)
![Obsidian percent|50%](./assets/img/test3.png)
![Pandoc attribute](./assets/img/test4.png){width=350px}
![Pandoc dims](./assets/img/test5.png){400x250}
Some important text.
`;
    const result = stripLessonMedia(input);
    expect(result).not.toContain('./assets/img');
    expect(result).not.toContain('![');
    expect(result).toBe('# Title\n\nSome important text.');
  });

  it('strips HTML img and picture elements', () => {
    const input = `
<picture>
  <source srcset="./assets/img/large.jpg" media="(min-width: 800px)">
  <img src="./assets/img/small.jpg" alt="Responsive">
</picture>
<img src="./assets/img/badge.png" alt="Badge" />
<img src="./assets/img/photo.png"></img>
Content preserved.
`;
    const result = stripLessonMedia(input);
    expect(result).not.toContain('picture');
    expect(result).not.toContain('img');
    expect(result).toBe('Content preserved.');
  });

  it('strips images wrapped inside markdown links', () => {
    const input = `
Before
[![Clickable banner](./assets/img/banner.jpg)](https://example.com)
After
`;
    const result = stripLessonMedia(input);
    expect(result).not.toContain('banner.jpg');
    expect(result).not.toContain('example.com');
    expect(result).toBe('Before\n\nAfter');
  });

  it('unwraps informative link text and strips inaccessible URLs', () => {
    const input = `
Refer to [the Canadian Charter of Rights and Freedoms](https://laws-lois.justice.gc.ca/eng/const/page-12.html).
Also see [At Least 137 Former Players Accept NHL Concussion Lawsuit Settlement](../assets/lockerdocs/clu3m04.02.100.html).
According to <a href="https://example.com/statute">Section 7 of the Charter</a>, life and liberty are protected.
`;
    const result = stripLessonMedia(input);
    expect(result).toContain('Refer to the Canadian Charter of Rights and Freedoms.');
    expect(result).toContain('Also see At Least 137 Former Players Accept NHL Concussion Lawsuit Settlement.');
    expect(result).toContain('According to Section 7 of the Charter, life and liberty are protected.');
    expect(result).not.toContain('laws-lois');
    expect(result).not.toContain('lockerdocs');
    expect(result).not.toContain('http');
  });

  it('strips bare URLs, file path links, and non-informative link texts', () => {
    const input = `
Visit <https://example.com/portal> for updates.
Check out [https://example.com/guide](https://example.com/guide).
Download [guide.pdf](./assets/lockerdocs/guide.pdf).
See [./assets/lockerdocs/handbook.pdf](./assets/lockerdocs/handbook.pdf).
View [image](./assets/img/photo.png).
`;
    const result = stripLessonMedia(input);
    expect(result).not.toContain('example.com');
    expect(result).not.toContain('guide.pdf');
    expect(result).not.toContain('handbook.pdf');
    expect(result).not.toContain('photo.png');
    expect(result).toBe('Visit for updates.\nCheck out .\nDownload .\nSee .\nView .');
  });

  it('strips images in blockquotes and list items without leaving orphan markers', () => {
    const input = `
> [!TIP]
> ### Think
> ![Think icon](./assets/icons/think.svg)
> Why do you think long-term relationships can become legal issues?

- Point 1
- ![Photo only](./assets/img/point.png)
- Point 2 with ![Inline](./assets/icons/bullet.svg) icon
`;
    const result = stripLessonMedia(input);
    expect(result).not.toContain('think.svg');
    expect(result).not.toContain('point.png');
    expect(result).not.toContain('bullet.svg');
    expect(result).toContain('> [!TIP]\n> ### Think\n> Why do you think long-term relationships can become legal issues?');
    expect(result).toContain('- Point 1\n- Point 2 with icon');
  });

  it('preserves fenced code blocks even if they contain image or link syntax', () => {
    const input = `
\`\`\`markdown
![Sample](./assets/img/sample.jpg)
[Sample link](https://example.com)
\`\`\`
Text outside.
`;
    const result = stripLessonMedia(input);
    expect(result).toContain('![Sample](./assets/img/sample.jpg)');
    expect(result).toContain('[Sample link](https://example.com)');
    expect(result).toContain('Text outside.');
  });

  it('preserves LaTeX math formulas containing brackets or parentheses', () => {
    const input = `
Interval formula: $x \\in [0, 1]$ and function $f(x) = x^2$.
Display formula:
$$
\\int_{[a, b]} g(x) dx
$$
`;
    const result = stripLessonMedia(input);
    expect(result).toContain('$x \\in [0, 1]$');
    expect(result).toContain('f(x) = x^2');
    expect(result).toContain('\\int_{[a, b]} g(x) dx');
  });

  it('preserves YAML frontmatter intact', () => {
    const input = `---
title: 4.3 Living with family law
courseId: clu3m
unit: 4
---

# 4.3 Living with family law
![Header photo](./assets/img/header.jpg)
Content of the lesson.
`;
    const result = stripLessonMedia(input);
    expect(result).toContain('title: 4.3 Living with family law');
    expect(result).toContain('courseId: clu3m');
    expect(result).not.toContain('header.jpg');
    expect(result).toContain('# 4.3 Living with family law\n\nContent of the lesson.');
  });

  it('preserves tables while stripping cell images and unwrapping links', () => {
    const input = `
| Jurisdiction | Symbol | Document |
| :--- | :--- | :--- |
| Federal | ![Coat of arms](./assets/img/arms.png) | [Constitution](https://example.com/law) |
| Municipal | ![City logo](./assets/img/logo.png) | By-laws |
`;
    const result = stripLessonMedia(input);
    expect(result).not.toContain('./assets/img');
    expect(result).toContain('| Federal | | Constitution |');
    expect(result).toContain('| Municipal | | By-laws |');
  });

  it('handles empty, null, and undefined gracefully', () => {
    expect(stripLessonMedia(null)).toBe('');
    expect(stripLessonMedia(undefined)).toBe('');
    expect(stripLessonMedia('')).toBe('');
    expect(stripLessonMedia('   ')).toBe('');
    expect(stripLessonMedia('Plain text without media.')).toBe('Plain text without media.');
  });
});
