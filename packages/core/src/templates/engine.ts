import Handlebars from 'handlebars';

// Register custom helpers
Handlebars.registerHelper('json', function(context) {
  return JSON.stringify(context);
});

Handlebars.registerHelper('ifEquals', function(this: unknown, arg1: unknown, arg2: unknown, options: Handlebars.HelperOptions) {
  return arg1 === arg2 ? options.fn(this) : options.inverse(this);
});

Handlebars.registerHelper('join', function(array: unknown[], separator: string) {
  if (!Array.isArray(array)) return '';
  return array.join(separator);
});

Handlebars.registerHelper('default', function(value: unknown, defaultValue: unknown) {
  return value ?? defaultValue;
});

export class TemplateEngine {
  private compiledTemplates = new Map<string, HandlebarsTemplateDelegate>();

  compile(templateId: string, template: string): void {
    this.compiledTemplates.set(templateId, Handlebars.compile(template));
  }

  hasTemplate(templateId: string): boolean {
    return this.compiledTemplates.has(templateId);
  }

  transform(templateId: string, data: unknown): string {
    const template = this.compiledTemplates.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    return template(data);
  }

  transformToObject<T>(templateId: string, data: unknown): T {
    const result = this.transform(templateId, data);
    return JSON.parse(result) as T;
  }
}

export const defaultEngine = new TemplateEngine();
