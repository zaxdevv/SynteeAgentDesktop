// ── Vision tools: analyze_image ────────────────────────────────────────
// Распознавание картинок с диска. Механика двойная (паритет с вложениями):
// основная модель с vision получает картинку напрямую (multipart
// tool-сообщение), text-only — структурированное описание от
// вспомогательной vision-модели. Решение принимает эвристика
// core/ai/visionSupport.ts автоматически.

export const VISION_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'analyze_image',
      description: 'Analyze an image file on disk (screenshot, photo, diagram, UI mockup, document scan) and get its content: what is depicted, all visible text (OCR), visual details. Use when the user refers to an image file by path, when you find a screenshot/image during work and need to see what is on it, or when you need to read text from a picture. If you support vision, this tool loads and attaches the image pixels, not a completed description: inspect the pixels yourself in your next response, answer the question and briefly state concrete visual observations before continuing with other tools. Do not treat the image-loaded receipt as the analysis. Otherwise a vision model returns a description.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the image file (absolute, or relative to the working directory)' },
          question: { type: 'string', description: 'Optional question about the image — focuses the analysis (e.g. "what error is shown?", "read the highlighted text")' },
        },
        required: ['path'],
      },
    },
  },
] as const
