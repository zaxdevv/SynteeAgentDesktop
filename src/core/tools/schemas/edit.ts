// ── Edit/write tool schemas ─────────────────────────────────────────────

export const EDIT_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Edit a file. You MUST read the file with read_file before calling edit_file — old_str must match the actual file content. Pass old_str (exact text to find) and new_str (replacement text) — the tool finds old_str in the file and replaces it with new_str. Fuzzy-matches whitespace/indentation differences. If old_str appears multiple times, add more surrounding lines to make it unique. create_if_not_exists=true creates the file and directories. Returns a diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          old_str: { type: 'string', description: 'The exact text to find in the file. Copy it from read_file output. Must match exactly (including whitespace and indentation). If found multiple times, add more surrounding lines to make it unique.' },
          new_str: { type: 'string', description: 'The text to replace old_str with. Must be different from old_str. Pass empty string "" to delete old_str.' },
          create_if_not_exists: { type: 'boolean', description: 'Создать файл (и директории) если не существует' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write file content. Creates a new file or overwrites an existing one. Returns a diff. For targeted edits to an existing file, prefer edit_file (old_str/new_str).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_image',
      description: 'Сгенерировать изображение по текстовому описанию. Используй когда пользователь просит нарисовать, создать или сгенерировать изображение/картинку.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Детальное описание изображения на английском языке для лучшего качества' },
          model: { type: 'string', description: 'Модель генерации (опционально). Например: dall-e-3, dall-e-2, gpt-image-1' },
          size: { type: 'string', description: 'Размер изображения (опционально). Например: 1024x1024, 1792x1024, 1024x1792' },
          quality: { type: 'string', description: 'Качество: standard, hd (dall-e-3) или low, medium, high (gpt-image-1)' },
          style: { type: 'string', description: 'Стиль (только dall-e-3): vivid или natural' },
        },
        required: ['prompt'],
      },
    },
  },
] as const
