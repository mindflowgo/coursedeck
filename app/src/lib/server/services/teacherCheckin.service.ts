import { createTransport, presets, type Transport } from '@lacspace/mailer';
import { loadAppSettings, saveAppSettings, type TeacherCheckinConfig } from '../paths';

export interface PopQuizQuestionResult {
  number: string;
  category?: string;
  type: 'multiple-choice' | 'fill-in-the-blank' | 'short-answer';
  prompt: string;
  options?: Array<{ letter: string; text: string }>;
  studentAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  score?: number;
  explanation?: string;
  feedback?: string;
  parts?: Array<{
    part?: string;
    label?: string;
    isCorrect: boolean;
    feedback?: string;
  }>;
}

export interface PopQuizResultPayload {
  courseId: string;
  lessonId: string;
  lessonTitle?: string;
  timestamp: string;
  timeSpentSeconds?: number;
  timedOut?: boolean;
  questions: PopQuizQuestionResult[];
  score: number;
  total: number;
  percentage: number;
}

export interface UnitTestQuestionResult {
  number: string;
  category?: string;
  type: 'multiple-choice' | 'fill-in-the-blank' | 'short-answer';
  prompt: string;
  options?: Array<{ letter: string; text: string }>;
  studentAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  score?: number;
  explanation?: string;
  feedback?: string;
  parts?: Array<{
    part?: string;
    label?: string;
    isCorrect: boolean;
    feedback?: string;
  }>;
}

export interface UnitTestResultPayload {
  courseId: string;
  unitId: string;
  unitTitle?: string;
  timestamp: string;
  questions: UnitTestQuestionResult[];
  score: number;
  total: number;
  percentage: number;
}

/**
 * Strips markdown and HTML image references from text.
 * e.g. ![alt|50%](./assets/img/...) or <img ...>
 */
export function cleanImageReferences(text: string | null | undefined): string {
  if (!text) return '';
  let cleaned = text
    // Strip markdown images: ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Strip HTML images and picture tags
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
    .replace(/<img\b[^>]*>(?:<\/img>)?/gi, '')
    // Strip markdown header hashes if present
    .replace(/^#+\s*/, '')
    // Collapse excess whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Strip leading and trailing separator artifacts e.g. " - " or ": "
  cleaned = cleaned.replace(/^[\s—–:-]+/, '').replace(/[\s—–:-]+$/, '').trim();

  return cleaned;
}

/**
 * Splits a raw string by comma and trims whitespace from each entry,
 * filtering out any empty strings.
 * e.g. "name1@email.com, name2@email.com" -> ["name1@email.com", "name2@email.com"]
 * e.g. "name1@email.com,name2@email.com"  -> ["name1@email.com", "name2@email.com"]
 */
export function parseRecipientEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

export class TeacherCheckinService {
  static getConfig(): TeacherCheckinConfig | null {
    const settings = loadAppSettings();
    return settings.teacher_checkin || null;
  }

  static saveConfig(config: TeacherCheckinConfig): void {
    const recipients = parseRecipientEmails(config.email);
    const normalizedEmail = recipients.join(', ');
    saveAppSettings({
      teacher_checkin: {
        email: normalizedEmail,
        sender: config.sender === 'outlook' ? 'outlook' : 'gmail',
        loginEmail: (config.loginEmail || '').trim(),
        loginPassword: config.loginPassword || ''
      }
    });
  }

  static getSafeConfig(): {
    email: string;
    sender: 'gmail' | 'outlook';
    loginEmail: string;
    hasPassword: boolean;
  } {
    const config = this.getConfig();
    return {
      email: config?.email || '',
      sender: config?.sender || 'gmail',
      loginEmail: config?.loginEmail || '',
      hasPassword: Boolean(config?.loginPassword && config.loginPassword.trim().length > 0)
    };
  }

  private static createMailerTransport(config?: TeacherCheckinConfig | null): Transport {
    const cfg = config || this.getConfig();
    if (!cfg) {
      throw new Error('Teacher Check-In is not configured. Please set up your credentials in Settings.');
    }
    const recipients = parseRecipientEmails(cfg.email);
    if (recipients.length === 0 || !cfg.loginEmail || !cfg.loginPassword) {
      throw new Error('Incomplete Teacher Check-In settings: at least one recipient email, login email, and login password are required.');
    }

    // Clean password: strip leading/trailing whitespace.
    // For Gmail app passwords, users often paste them with spaces (e.g. "abcd efgh ijkl mnop")
    let password = cfg.loginPassword.trim();
    if (cfg.sender === 'gmail') {
      const stripped = password.replace(/\s+/g, '');
      if (stripped.length === 16) {
        password = stripped;
      }
    }

    const auth = {
      user: cfg.loginEmail.trim(),
      pass: password,
      from: cfg.loginEmail.trim()
    };

    if (cfg.sender === 'outlook') {
      return createTransport(presets.outlook(auth));
    }
    return createTransport(presets.gmail(auth));
  }

  static async sendTestEmail(overrideConfig?: TeacherCheckinConfig): Promise<{ success: boolean; message: string }> {
    const cfg = overrideConfig || this.getConfig();
    const recipients = parseRecipientEmails(cfg?.email);
    if (!cfg || recipients.length === 0 || !cfg.loginEmail || !cfg.loginPassword) {
      throw new Error('Please fill in all Teacher Check-In fields (Email, Login Email, and Password) before sending a test.');
    }

    const transport = this.createMailerTransport(cfg);
    const now = new Date().toLocaleString();
    const recipientsLabel = recipients.join(', ');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; background-color: #ffffff; color: #111827;">
        <div style="border-bottom: 2px solid #10b981; padding-bottom: 16px; margin-bottom: 20px;">
          <h2 style="margin: 0; color: #047857; font-size: 20px;">CourseDeck Teacher Check-In Verified</h2>
          <p style="margin: 4px 0 0 0; color: #6b7280; font-size: 13px;">Test connection from student accountability system</p>
        </div>
        <p style="font-size: 14px; line-height: 1.5; color: #374151;">
          Hello! This is a test email verifying that CourseDeck can successfully communicate with this inbox using <strong>${cfg.sender === 'outlook' ? 'Outlook' : 'Gmail'}</strong> SMTP.
        </p>
        <div style="background-color: #f3f4f6; padding: 12px 16px; border-radius: 8px; margin: 16px 0; font-size: 13px; color: #4b5563;">
          <p style="margin: 4px 0;"><strong>Sender Account:</strong> ${cfg.loginEmail}</p>
          <p style="margin: 4px 0;"><strong>Recipient${recipients.length > 1 ? 's' : ''}:</strong> ${recipientsLabel}</p>
          <p style="margin: 4px 0;"><strong>Timestamp:</strong> ${now}</p>
        </div>
        <p style="font-size: 13px; color: #059669; font-weight: 500;">
          All pop quiz attempts and accountability updates will be sent to this email address.
        </p>
      </div>
    `;

    const text = `CourseDeck Teacher Check-In Verified\n\n` +
      `Test connection from student accountability system.\n\n` +
      `Sender: ${cfg.loginEmail}\n` +
      `Recipient${recipients.length > 1 ? 's' : ''}: ${recipientsLabel}\n` +
      `Timestamp: ${now}\n\n` +
      `Pop quiz attempts and accountability updates will be sent to this address.`;

    try {
      const result = await transport.send({
        from: cfg.loginEmail.trim(),
        to: recipients,
        subject: `[CourseDeck] Teacher Check-In Test Email - ${now}`,
        html,
        text
      });

      return {
        success: true,
        message: `Test email sent successfully to ${recipientsLabel} (Message ID: ${result.messageId || 'OK'})`
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('535') || errMsg.includes('235')) {
        const provider = cfg.sender === 'outlook' ? 'Outlook' : 'Gmail';
        if (cfg.sender === 'gmail') {
          throw new Error(
            `Authentication failed (SMTP Error 535) for Gmail: Invalid login credentials.\n\n` +
            `Note: Google blocks your standard account login password for automated SMTP.\n` +
            `You must generate and use a 16-character Google App Password:\n` +
            `1. Go to Google Account Settings (myaccount.google.com/security)\n` +
            `2. Ensure 2-Step Verification is turned ON\n` +
            `3. Search for "App passwords"\n` +
            `4. Create an App password named "CourseDeck"\n` +
            `5. Paste the 16-character code into the password field.`
          );
        } else {
          throw new Error(
            `Authentication failed (SMTP Error 535) for Outlook: Invalid login credentials.\n\n` +
            `Please verify your username and password. If your Microsoft account has 2-Step Verification enabled, generate and use an App Password from account.live.com/proofs/manage/additional.`
          );
        }
      }
      throw err;
    }
  }

  static async sendQuizResultEmail(payload: PopQuizResultPayload): Promise<{ success: boolean; messageId: string }> {
    const cfg = this.getConfig();
    const recipients = parseRecipientEmails(cfg?.email);
    if (!cfg || recipients.length === 0 || !cfg.loginEmail || !cfg.loginPassword) {
      throw new Error('Teacher Check-In is not configured. Quiz results were recorded locally, but could not be emailed.');
    }

    const transport = this.createMailerTransport(cfg);
    const courseCode = payload.courseId.toUpperCase();
    const cleanTitle = cleanImageReferences(payload.lessonTitle);
    const headingTitle = cleanTitle ? ` - ${cleanTitle}` : '';
    const textTitle = cleanTitle ? ` (${cleanTitle})` : '';
    const timeFormatted = payload.timeSpentSeconds !== undefined
      ? `${Math.floor(payload.timeSpentSeconds / 60)}m ${payload.timeSpentSeconds % 60}s`
      : 'Under 5m';

    const subject = `[CourseDeck] ${courseCode} - ${payload.lessonId} (Pop Quiz)`;

    const scoreColor = payload.percentage >= 75 ? '#059669' : payload.percentage >= 50 ? '#d97706' : '#dc2626';
    const scoreBg = payload.percentage >= 75 ? '#ecfdf5' : payload.percentage >= 50 ? '#fffbeb' : '#fef2f2';

    // Format questions HTML
    const questionsHtml = payload.questions.map((q, idx) => {
      const qNum = q.number || String(idx + 1).padStart(2, '0');
      const isCorrect = q.isCorrect;
      const statusIcon = isCorrect ? '&#10004;' : '&#10008;';
      const statusColor = isCorrect ? '#16a34a' : '#dc2626';
      const statusBg = isCorrect ? '#f0fdf4' : '#fef2f2';
      const borderCol = isCorrect ? '#bbf7d0' : '#fecaca';

      const cleanPrompt = cleanImageReferences(q.prompt);
      const cleanStudentAnswer = cleanImageReferences(q.studentAnswer);
      const cleanCorrectAnswer = cleanImageReferences(q.correctAnswer);
      const cleanExplanation = q.explanation ? cleanImageReferences(q.explanation) : '';

      let optionsHtml = '';
      if (q.type === 'multiple-choice' && q.options && q.options.length > 0) {
        optionsHtml = `
          <div style="margin: 8px 0; padding-left: 8px;">
            ${q.options.map(opt => {
              const cleanOptText = cleanImageReferences(opt.text);
              const isSelected = cleanStudentAnswer.toUpperCase() === opt.letter.toUpperCase();
              const isOptionCorrect = cleanCorrectAnswer.toUpperCase() === opt.letter.toUpperCase();
              let optStyle = 'color: #4b5563; font-size: 13px; margin: 3px 0;';
              let optBadge = `<span style="font-family: monospace; display: inline-block; width: 18px;">${opt.letter})</span>`;
              if (isSelected && isCorrect) {
                optStyle = 'color: #15803d; font-weight: 600; font-size: 13px; margin: 3px 0;';
              } else if (isSelected && !isCorrect) {
                optStyle = 'color: #b91c1c; font-weight: 600; font-size: 13px; margin: 3px 0; text-decoration: line-through;';
              } else if (isOptionCorrect && !isCorrect) {
                optStyle = 'color: #15803d; font-weight: 600; font-size: 13px; margin: 3px 0;';
              }
              return `<div style="${optStyle}">${optBadge} ${cleanOptText}</div>`;
            }).join('')}
          </div>
        `;
      }

      return `
        <div style="margin-bottom: 16px; border: 1px solid ${borderCol}; border-radius: 8px; padding: 14px; background-color: ${statusBg};">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
            <div style="font-weight: 600; font-size: 13px; color: #111827;">
              Question ${qNum} <span style="font-weight: normal; color: #6b7280; font-size: 11px;">(${q.type === 'fill-in-the-blank' ? 'Fill in the Blank' : 'Multiple Choice'})</span>
            </div>
            <div style="font-weight: 700; font-size: 12px; color: ${statusColor};">
              ${statusIcon} ${isCorrect ? 'CORRECT' : 'INCORRECT'}
            </div>
          </div>
          <p style="margin: 4px 0 8px 0; font-size: 13px; color: #1f2937; line-height: 1.4;">${cleanPrompt}</p>
          ${optionsHtml}
          <div style="margin-top: 8px; font-size: 12px; line-height: 1.5; border-top: 1px dashed ${borderCol}; padding-top: 6px;">
            <div style="margin: 2px 0;">
              <strong>Student Answer:</strong>
              <span style="color: ${statusColor}; font-weight: 600;">${cleanStudentAnswer || '(No answer provided)'}</span>
            </div>
            ${!isCorrect ? `
              <div style="margin: 2px 0;">
                <strong>Correct Answer:</strong>
                <span style="color: #15803d; font-weight: 600;">${cleanCorrectAnswer}</span>
              </div>
            ` : ''}
            ${cleanExplanation ? `
              <div style="margin-top: 4px; color: #4b5563; font-style: italic;">
                <strong>Explanation:</strong> ${cleanExplanation}
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; background-color: #ffffff; color: #111827;">
        <!-- Header -->
        <div style="border-bottom: 2px solid #059669; padding-bottom: 14px; margin-bottom: 18px;">
          <div style="display: inline-block; background-color: #f59e0b; color: #ffffff; font-size: 11px; font-weight: bold; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; margin-bottom: 6px;">
            ${courseCode}
          </div>
          <h2 style="margin: 4px 0 0 0; color: #111827; font-size: 20px;">
            Pop Quiz: Lesson ${payload.lessonId}${headingTitle}
          </h2>
          <p style="margin: 4px 0 0 0; color: #6b7280; font-size: 12px;">
            Completed on ${new Date().toLocaleString()} &bull; Duration: ${timeFormatted} ${payload.timedOut ? '<strong style="color: #dc2626;">(Timer expired at 5m)</strong>' : ''}
          </p>
        </div>

        <!-- Score Banner -->
        <div style="background-color: ${scoreBg}; border: 1px solid ${scoreColor}; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
          <div>
            <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; font-weight: 600;">Quiz Result</div>
            <div style="font-size: 24px; font-weight: 800; color: ${scoreColor}; margin-top: 2px;">
              ${payload.score} / ${payload.total} (${payload.percentage}%)
            </div>
          </div>
          <div style="text-align: right; font-size: 12px; color: #4b5563;">
            <div><strong>Total Questions:</strong> ${payload.total}</div>
            <div><strong>Correct:</strong> ${payload.score}</div>
            <div><strong>Incorrect:</strong> ${payload.total - payload.score}</div>
          </div>
        </div>

        <!-- Questions Section -->
        <h3 style="font-size: 15px; font-weight: 600; color: #111827; margin: 0 0 12px 0;">Itemized Quiz Questions &amp; Answers:</h3>
        ${questionsHtml}

        <!-- Footer -->
        <div style="margin-top: 24px; padding-top: 14px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; text-align: center;">
          Sent automatically by CourseDeck Accountability System &bull; Heading: ${courseCode} - ${payload.lessonId}
        </div>
      </div>
    `;

    // Plain text alternative
    let text = `[CourseDeck] Pop Quiz Results: ${courseCode} - ${payload.lessonId}${textTitle}\n\n`;
    text += `Score: ${payload.score} / ${payload.total} (${payload.percentage}%)\n`;
    text += `Duration: ${timeFormatted} ${payload.timedOut ? '(Timer Expired)' : ''}\n`;
    text += `Date: ${new Date().toLocaleString()}\n\n`;
    text += `--- QUESTIONS & ANSWERS ---\n\n`;

    for (const q of payload.questions) {
      const isCorrect = q.isCorrect;
      const cleanQPrompt = cleanImageReferences(q.prompt);
      const cleanQStudent = cleanImageReferences(q.studentAnswer);
      const cleanQCorrect = cleanImageReferences(q.correctAnswer);
      const cleanQExpl = q.explanation ? cleanImageReferences(q.explanation) : '';

      text += `Q${q.number}) [${q.type}] ${cleanQPrompt}\n`;
      text += `Student Answer: ${cleanQStudent || '(None)'} [${isCorrect ? 'CORRECT' : 'INCORRECT'}]\n`;
      if (!isCorrect) {
        text += `Correct Answer: ${cleanQCorrect}\n`;
      }
      if (cleanQExpl) {
        text += `Explanation: ${cleanQExpl}\n`;
      }
      text += `\n`;
    }

    const finalHtml = html.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    const finalText = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

    const result = await transport.send({
      from: cfg.loginEmail.trim(),
      to: recipients,
      subject,
      html: finalHtml,
      text: finalText
    });

    return {
      success: true,
      messageId: result.messageId || 'SENT'
    };
  }

  static async sendUnitTestResultEmail(payload: UnitTestResultPayload): Promise<{ success: boolean; messageId: string }> {
    const cfg = this.getConfig();
    const recipients = parseRecipientEmails(cfg?.email);
    if (!cfg || recipients.length === 0 || !cfg.loginEmail || !cfg.loginPassword) {
      throw new Error('Teacher Check-In is not configured. Unit test results were recorded locally, but could not be emailed.');
    }

    const transport = this.createMailerTransport(cfg);
    const courseCode = payload.courseId.toUpperCase();
    const cleanTitle = cleanImageReferences(payload.unitTitle);
    const isCourseOverall = payload.unitId === 'course';
    const headingTitle = cleanTitle || (isCourseOverall ? `${courseCode} Practice Exam` : `Unit ${payload.unitId} Practice Test`);
    const textTitle = cleanTitle ? ` (${cleanTitle})` : '';

    const subject = isCourseOverall
      ? `[CourseDeck] ${courseCode} - Practice Exam`
      : `[CourseDeck] ${courseCode} - ${payload.unitId} (Unit Practice Test)`;

    const scoreColor = payload.percentage >= 75 ? '#059669' : payload.percentage >= 50 ? '#d97706' : '#dc2626';
    const scoreBg = payload.percentage >= 75 ? '#ecfdf5' : payload.percentage >= 50 ? '#fffbeb' : '#fef2f2';

    // Format questions HTML
    const questionsHtml = payload.questions.map((q, idx) => {
      const qNum = q.number || String(idx + 1).padStart(2, '0');
      const isCorrect = q.isCorrect;
      const qScore = typeof q.score === 'number' ? q.score : (isCorrect ? 1 : 0);
      const isPartial = !isCorrect && qScore > 0 && qScore < 1;

      const statusIcon = isCorrect ? '&#10004;' : isPartial ? '&#9650;' : '&#10008;';
      const statusColor = isCorrect ? '#16a34a' : isPartial ? '#d97706' : '#dc2626';
      const statusBg = isCorrect ? '#f0fdf4' : isPartial ? '#fffbeb' : '#fef2f2';
      const borderCol = isCorrect ? '#bbf7d0' : isPartial ? '#fde68a' : '#fecaca';
      const statusText = isCorrect ? `CORRECT (${qScore}/1)` : isPartial ? `PARTIAL (${qScore}/1)` : `INCORRECT (${qScore}/1)`;

      const cleanPrompt = cleanImageReferences(q.prompt);
      const cleanStudentAnswer = cleanImageReferences(q.studentAnswer);
      const cleanCorrectAnswer = cleanImageReferences(q.correctAnswer);
      const cleanFeedback = cleanImageReferences(q.feedback || q.explanation || '');

      const typeLabel = q.type === 'fill-in-the-blank'
        ? 'Fill in the Blank'
        : q.type === 'short-answer'
          ? 'Short Answer'
          : 'Multiple Choice';

      let optionsHtml = '';
      if (q.type === 'multiple-choice' && q.options && q.options.length > 0) {
        optionsHtml = `
          <div style="margin: 8px 0; padding-left: 8px;">
            ${q.options.map(opt => {
              const cleanOptText = cleanImageReferences(opt.text);
              const isSelected = cleanStudentAnswer.toUpperCase() === opt.letter.toUpperCase();
              const isOptionCorrect = cleanCorrectAnswer.toUpperCase() === opt.letter.toUpperCase();
              let optStyle = 'color: #4b5563; font-size: 13px; margin: 3px 0;';
              let optBadge = `<span style="font-family: monospace; display: inline-block; width: 18px;">${opt.letter})</span>`;
              if (isSelected && isCorrect) {
                optStyle = 'color: #15803d; font-weight: 600; font-size: 13px; margin: 3px 0;';
              } else if (isSelected && !isCorrect) {
                optStyle = 'color: #b91c1c; font-weight: 600; font-size: 13px; margin: 3px 0; text-decoration: line-through;';
              } else if (isOptionCorrect && !isCorrect) {
                optStyle = 'color: #15803d; font-weight: 600; font-size: 13px; margin: 3px 0;';
              }
              return `<div style="${optStyle}">${optBadge} ${cleanOptText}</div>`;
            }).join('')}
          </div>
        `;
      }

      let partsHtml = '';
      if (q.parts && q.parts.length > 0) {
        const correctPartsCount = q.parts.filter(p => p.isCorrect).length;
        partsHtml = `
          <div style="margin: 10px 0 6px 0; padding: 10px 12px; background-color: #ffffff; border: 1px solid ${borderCol}; border-radius: 6px;">
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #4b5563; margin-bottom: 6px;">
              Sub-Part Breakdown (${correctPartsCount}/${q.parts.length} Correct)
            </div>
            ${q.parts.map(p => {
              const partIcon = p.isCorrect ? '&#10004;' : '&#10008;';
              const partColor = p.isCorrect ? '#16a34a' : '#dc2626';
              const partLabel = p.label || ('Part ' + (p.part || '').toUpperCase());
              const partFeedback = p.feedback ? cleanImageReferences(p.feedback) : '';
              return `
                <div style="font-size: 12px; margin: 4px 0; display: flex; align-items: flex-start;">
                  <span style="color: ${partColor}; font-weight: bold; width: 16px; display: inline-block;">${partIcon}</span>
                  <div>
                    <strong>${partLabel}:</strong>
                    ${partFeedback ? `<span style="color: #374151; margin-left: 4px;">${partFeedback}</span>` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }

      let answerDetailsHtml = '';
      if (q.type === 'multiple-choice') {
        answerDetailsHtml = `
          <div style="margin: 2px 0;">
            <strong>Student Answer:</strong>
            <span style="color: ${statusColor}; font-weight: 600;">${cleanStudentAnswer || '(No answer provided)'}</span>
          </div>
          ${!isCorrect && cleanCorrectAnswer ? `
            <div style="margin: 2px 0;">
              <strong>Correct Answer:</strong>
              <span style="color: #15803d; font-weight: 600;">${cleanCorrectAnswer}</span>
            </div>
          ` : ''}
        `;
      } else if (q.type === 'fill-in-the-blank') {
        answerDetailsHtml = `
          <div style="margin: 2px 0;">
            <strong>Student Answer:</strong>
            <span style="color: ${statusColor}; font-weight: 600;">${cleanStudentAnswer || '(No answer provided)'}</span>
          </div>
          ${cleanCorrectAnswer ? `
            <div style="margin: 2px 0;">
              <strong>Expected Answer:</strong>
              <span style="color: #15803d; font-weight: 600;">${cleanCorrectAnswer}</span>
            </div>
          ` : ''}
        `;
      } else {
        // Short answer
        answerDetailsHtml = `
          <div style="margin: 4px 0;">
            <strong>Student Response:</strong>
            <div style="margin-top: 3px; padding: 8px 10px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; white-space: pre-wrap; color: #1f2937;">
              ${cleanStudentAnswer || '(No answer provided)'}
            </div>
          </div>
          ${cleanCorrectAnswer ? `
            <div style="margin: 6px 0 2px 0;">
              <strong>Rubric / Expected Content:</strong>
              <div style="margin-top: 3px; padding: 8px 10px; background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 12px; color: #374151; white-space: pre-wrap;">
                ${cleanCorrectAnswer}
              </div>
            </div>
          ` : ''}
        `;
      }

      return `
        <div style="margin-bottom: 16px; border: 1px solid ${borderCol}; border-radius: 8px; padding: 14px; background-color: ${statusBg};">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
            <div style="font-weight: 600; font-size: 13px; color: #111827;">
              Question ${qNum}
              ${q.category ? `<span style="font-size: 11px; background-color: #f3f4f6; color: #4b5563; padding: 1px 6px; border-radius: 4px; margin-left: 6px; font-weight: 500;">${cleanImageReferences(q.category)}</span>` : ''}
              <span style="font-weight: normal; color: #6b7280; font-size: 11px; margin-left: 4px;">(${typeLabel})</span>
            </div>
            <div style="font-weight: 700; font-size: 12px; color: ${statusColor};">
              ${statusIcon} ${statusText}
            </div>
          </div>
          <p style="margin: 4px 0 8px 0; font-size: 13px; color: #1f2937; line-height: 1.4;">${cleanPrompt}</p>
          ${optionsHtml}
          <div style="margin-top: 8px; font-size: 12px; line-height: 1.5; border-top: 1px dashed ${borderCol}; padding-top: 6px;">
            ${answerDetailsHtml}
            ${partsHtml}
            ${cleanFeedback ? `
              <div style="margin-top: 6px; color: #4b5563; font-style: italic; font-size: 12px;">
                <strong>AI Feedback / Explanation:</strong> ${cleanFeedback}
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; background-color: #ffffff; color: #111827;">
        <!-- Header -->
        <div style="border-bottom: 2px solid #059669; padding-bottom: 14px; margin-bottom: 18px;">
          <div style="margin-bottom: 6px;">
            <span style="display: inline-block; background-color: #2563eb; color: #ffffff; font-size: 11px; font-weight: bold; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; margin-right: 6px;">
              ${courseCode}
            </span>
            <span style="display: inline-block; background-color: #059669; color: #ffffff; font-size: 11px; font-weight: bold; padding: 2px 8px; border-radius: 4px; text-transform: uppercase;">
              Unit Practice Test
            </span>
          </div>
          <h2 style="margin: 4px 0 0 0; color: #111827; font-size: 20px;">
            ${headingTitle}
          </h2>
          <p style="margin: 4px 0 0 0; color: #6b7280; font-size: 12px;">
            Completed on ${payload.timestamp || new Date().toLocaleString()} &bull; Target: ${payload.unitId}
          </p>
        </div>

        <!-- Score Banner -->
        <div style="background-color: ${scoreBg}; border: 1px solid ${scoreColor}; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
          <div>
            <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; font-weight: 600;">Unit Test Result</div>
            <div style="font-size: 24px; font-weight: 800; color: ${scoreColor}; margin-top: 2px;">
              ${payload.score} / ${payload.total} (${payload.percentage}%)
            </div>
            <div style="font-size: 11px; color: #059669; font-weight: 600; margin-top: 3px;">
              &#10004; Recorded to Unit Frontmatter
            </div>
          </div>
          <div style="text-align: right; font-size: 12px; color: #4b5563;">
            <div><strong>Total Questions:</strong> ${payload.total}</div>
            <div><strong>Mark:</strong> ${payload.score}</div>
            <div><strong>Percentage:</strong> ${payload.percentage}%</div>
          </div>
        </div>

        <!-- Questions Section -->
        <h3 style="font-size: 15px; font-weight: 600; color: #111827; margin: 0 0 12px 0;">Itemized Unit Test Questions &amp; Evaluations:</h3>
        ${questionsHtml}

        <!-- Footer -->
        <div style="margin-top: 24px; padding-top: 14px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; text-align: center;">
          Sent automatically by CourseDeck Accountability System &bull; Unit Practice Test: ${courseCode} - ${payload.unitId}
        </div>
      </div>
    `;

    // Plain text alternative
    let text = `[CourseDeck] Unit Practice Test Results: ${courseCode} - ${payload.unitId}${textTitle}\n\n`;
    text += `Score: ${payload.score} / ${payload.total} (${payload.percentage}%)\n`;
    text += `Date: ${payload.timestamp || new Date().toLocaleString()}\n`;
    text += `Status: Recorded to Unit Test Frontmatter\n\n`;
    text += `--- QUESTIONS & ANSWERS ---\n\n`;

    for (const q of payload.questions) {
      const isCorrect = q.isCorrect;
      const qScore = typeof q.score === 'number' ? q.score : (isCorrect ? 1 : 0);
      const isPartial = !isCorrect && qScore > 0 && qScore < 1;
      const statusTag = isCorrect ? 'CORRECT (1/1)' : isPartial ? `PARTIAL (${qScore}/1)` : 'INCORRECT (0/1)';
      const cleanQPrompt = cleanImageReferences(q.prompt);
      const cleanQStudent = cleanImageReferences(q.studentAnswer);
      const cleanQCorrect = cleanImageReferences(q.correctAnswer);
      const cleanFeedback = cleanImageReferences(q.feedback || q.explanation || '');

      const categoryTag = q.category ? ` [${cleanImageReferences(q.category)}]` : '';
      text += `Q${q.number})${categoryTag} [${q.type}] ${cleanQPrompt}\n`;
      text += `Student Answer: ${cleanQStudent || '(No answer provided)'} [${statusTag}]\n`;
      if (cleanQCorrect) {
        text += `Expected Answer / Rubric: ${cleanQCorrect}\n`;
      }
      if (q.parts && q.parts.length > 0) {
        text += `Sub-Parts:\n`;
        for (const p of q.parts) {
          text += `  - ${p.label || p.part}: ${p.isCorrect ? 'PASS' : 'FAIL'}${p.feedback ? ` (${cleanImageReferences(p.feedback)})` : ''}\n`;
        }
      }
      if (cleanFeedback) {
        text += `Feedback: ${cleanFeedback}\n`;
      }
      text += `\n`;
    }

    const finalHtml = html.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    const finalText = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

    const result = await transport.send({
      from: cfg.loginEmail.trim(),
      to: recipients,
      subject,
      html: finalHtml,
      text: finalText
    });

    return {
      success: true,
      messageId: result.messageId || 'SENT'
    };
  }
}
