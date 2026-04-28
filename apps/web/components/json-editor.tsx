'use client';

import React from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
}

/**
 * JSON Editor Component — predicated upon Monaco Editor
 * Provides syntax highlighting,To Format,Verification function
 */
export function JsonEditor({ value, onChange, height = '400px', readOnly = false }: JsonEditorProps) {
  const handleMount: OnMount = (editor, monaco) => {
    // Configure JSON Diagnostic Options
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      trailingCommas: 'error',
    });

    // Register Formatting Shortcuts (Shift+Alt+F)
    editor.addAction({
      id: 'format-json',
      label: 'To Format JSON',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      run: (ed) => {
        ed.getAction('editor.action.formatDocument')?.run();
      },
    });
  };

  return (
    <div className="overflow-hidden rounded-md border">
      <Editor
        height={height}
        defaultLanguage="json"
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onMount={handleMount}
        theme="vs-light"
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'on',
          folding: true,
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          formatOnPaste: true,
          renderLineHighlight: 'gutter',
          overviewRulerBorder: false,
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
        }}
      />
    </div>
  );
}
