// Native inline analysis call to the current capable chat model, auxiliary assignment fallback; results are text.
export const MEDIA_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'analyze_video',
      description: 'Analyze local video using the current chat model when its native media transport is supported; otherwise uses the auxiliary video assignment. Returns text, not native video context in the chat. Requires Gemini at the official Google endpoint. MP4/MOV/WebM/MPEG, maximum 14 MiB. No hosting, conversion or time-range extraction; unsupported proxies fail closed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Local video path, absolute or relative to the working directory.' },
          question: { type: 'string', description: 'Optional question to focus the analysis.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'analyze_audio',
      description: 'Analyze or transcribe local audio using the current chat model when its native media transport is supported; otherwise uses the auxiliary audio assignment. Returns text, not native audio context in the chat. Official Gemini supports WAV/MP3/FLAC/OGG/AAC/AIFF; supported official OpenAI audio-chat models accept WAV/MP3. Maximum 14 MiB; no hosting or conversion. Unsupported proxies fail closed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Local audio path, absolute or relative to the working directory.' },
          question: { type: 'string', description: 'Optional question or transcription instructions.' },
          task: { type: 'string', enum: ['analyze', 'transcribe'], description: 'Default analyze. Transcribe requests faithful original-language speech transcription from the assigned audio model.' },
        },
        required: ['path'],
      },
    },
  },
] as const
