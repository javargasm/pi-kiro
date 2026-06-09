// Static native Kiro CLI tool schemas.
//
// These schemas are extracted from real Kiro CLI request captures.
// pi-kiro injects these directly instead of converting Pi's tool definitions,
// ensuring the request is structurally identical to the real client.
//
// MCP tools (codegraph, pencil) are OMITTED — Pi handles those directly.

import type { KiroToolSpec } from "./transform";

/** Complete set of native Kiro CLI tools. */
export const KIRO_NATIVE_TOOLS: KiroToolSpec[] = [
  {
    toolSpecification: {
      name: "code",
      description:
        "\nCode intelligence with AST parsing and fuzzy search. Language auto-detected from file extension.\n\nCORE FEATURES:\n• Fuzzy search for symbols (classes, functions, methods)\n• Extracts function/class signatures via AST\n• Structural AST search and rewrite (ast-grep)\n• Codebase overview and directory exploration\n\nNOTE: LSP operations (find_references, goto_definition, get_hover, get_completions, get_diagnostics, rename_symbol) require LSP initialization.\n\n## Available Operations\n- search_symbols: Find symbol definitions by name\n- lookup_symbols: Batch lookup specific symbols\n- get_document_symbols: List all symbols in a file\n- pattern_search: AST-based structural search\n- pattern_rewrite: AST-based code transformation\n- generate_codebase_overview: High-level codebase structure\n- search_codebase_map: Focused directory exploration\n",
      inputSchema: {
        json: {
          type: "object",
          required: ["operation"],
          properties: {
            operation: {
              description: "The code intelligence operation to perform",
              enum: [
                "search_symbols",
                "lookup_symbols",
                "get_document_symbols",
                "pattern_search",
                "pattern_rewrite",
                "generate_codebase_overview",
                "search_codebase_map",
              ],
              type: "string",
            },
            symbol_name: {
              type: "string",
              description: "Symbol name (required for search_symbols)",
            },
            symbols: {
              description: "List of symbol names (required for lookup_symbols, max 10)",
              items: { type: "string" },
              type: "array",
            },
            file_path: {
              type: "string",
              description:
                "File path (required for get_document_symbols, optional for pattern_search/pattern_rewrite/search_codebase_map)",
            },
            path: {
              description:
                "Directory path (optional for search_symbols, generate_codebase_overview, search_codebase_map)",
              type: "string",
            },
            pattern: {
              type: "string",
              description: "AST pattern (required for pattern_search/pattern_rewrite)",
            },
            replacement: {
              description: "Replacement pattern (required for pattern_rewrite)",
              type: "string",
            },
            language: {
              description:
                "Programming language (required for pattern_search/pattern_rewrite, optional for search_symbols)",
              type: "string",
            },
            include_source: {
              description: "Include source code in results (optional for lookup_symbols)",
              type: "boolean",
            },
            top_level_only: {
              type: "boolean",
              description:
                "Only return top-level symbols (optional for get_document_symbols)",
            },
            limit: {
              description: "Maximum results (optional)",
              type: "integer",
            },
            dry_run: {
              description:
                "Preview changes without writing (optional for pattern_rewrite). After reviewing dry-run results, call again with dry_run=false to apply.",
              type: "boolean",
              default: true,
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "glob",
      description:
        "\nFind files and directories whose paths match a glob pattern. Respects .gitignore.\n\nWHEN TO USE:\n- Finding files by name pattern (e.g., \"*.rs\", \"**/*.tsx\")\n- Discovering project structure\n- Listing files in specific directories\n\nHOW TO USE:\n- Provide a glob pattern to match files\n- Optionally specify a root directory to search from\n- Optionally specify a limit on results and max depth\n\nPATTERNS:\n- \"*.rs\" - All .rs files in current directory\n- \"**/*.rs\" - All .rs files recursively\n- \"src/**/*.{ts,tsx}\" - All TypeScript files under src/\n",
      inputSchema: {
        json: {
          properties: {
            pattern: {
              type: "string",
              description: "Glob pattern, e.g. '**/*.rs', 'src/**/*.{ts,tsx}'",
            },
            path: {
              type: "string",
              description: "Root directory to search from. Defaults to current working directory",
            },
            limit: {
              type: "integer",
              description: "Maximum number of results to return",
            },
            max_depth: {
              description: "Maximum directory depth to traverse",
              type: "integer",
            },
            __tool_use_purpose: {
              description: "A brief explanation why you are making this tool use.",
              type: "string",
            },
          },
          required: ["pattern"],
          type: "object",
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "grep",
      description:
        "\nFast text pattern search in files using regex. Respects .gitignore.\n\nWHEN TO USE:\n- Searching for literal text patterns, error messages, TODOs, config values\n- Finding files containing specific text\n\nWHEN NOT TO USE:\n- For semantic code understanding, use the code tool instead\n- For finding symbol definitions or usages, use the code tool\n\nHOW TO USE:\n- Provide a regex pattern to search for\n- Optionally specify a path to search from (defaults to current directory)\n- Optionally specify a file filter glob (e.g., \"*.rs\", \"*.{ts,tsx}\")\n\nOUTPUT MODES:\n- content: Show matching lines with file path and line number (default)\n- files_with_matches: Only show file paths that contain matches\n- count: Show count of matches per file\n",
      inputSchema: {
        json: {
          required: ["pattern"],
          type: "object",
          properties: {
            pattern: {
              description: "Regex pattern to search for",
              type: "string",
            },
            path: {
              description: "Directory to search from, defaults to current working directory",
              type: "string",
            },
            include: {
              description: "File filter glob, e.g. '*.rs', '*.{ts,tsx}'",
              type: "string",
            },
            output_mode: {
              description:
                "Output format: content (default), files_with_matches, or count",
              type: "string",
              enum: ["content", "files_with_matches", "count"],
            },
            case_sensitive: {
              type: "boolean",
              description: "Case-sensitive search, defaults to false",
            },
            max_matches_per_file: {
              type: "integer",
              description: "Maximum matches to return per file (content mode only)",
            },
            max_files: {
              description: "Maximum number of files to include in results",
              type: "integer",
            },
            max_total_lines: {
              description: "Maximum total lines in output (content mode only)",
              type: "integer",
            },
            max_depth: {
              type: "integer",
              description: "Maximum directory depth to traverse",
            },
            __tool_use_purpose: {
              description: "A brief explanation why you are making this tool use.",
              type: "string",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "read",
      description:
        "\nRead files, directories, and images from the filesystem.\n\nProvide an array of operations. Each operation specifies a mode:\n- Line: Read text file content with optional offset/limit\n- Directory: List directory contents with optional depth\n- Image: Read image files and return base64-encoded content\n\nMultiple operations can be batched in a single call for efficiency.\n",
      inputSchema: {
        json: {
          required: ["operations"],
          type: "object",
          properties: {
            operations: {
              minItems: 1,
              description:
                "Array of operations to execute. Provide one element for single operation, multiple for batch.",
              type: "array",
              items: {
                properties: {
                  mode: {
                    description:
                      "The operation mode to run in: `Line` and `Directory` are for text files and directories respectively. `Image` is for image files, in this mode `image_paths` is required.",
                    enum: ["Line", "Directory", "Image"],
                    type: "string",
                  },
                  path: {
                    description:
                      "Path to the file or directory (required for Line, Directory modes).",
                    type: "string",
                  },
                  image_paths: {
                    items: { type: "string" },
                    description:
                      "List of paths to the images. Required for Image mode.",
                    type: "array",
                  },
                  offset: {
                    type: "integer",
                    description: "Starting line number (0-based). Optional for Line mode.",
                  },
                  limit: {
                    type: "integer",
                    description: "Maximum number of lines to read. Optional for Line mode.",
                  },
                  depth: {
                    type: "integer",
                    description:
                      "Maximum directory depth to traverse. Optional for Directory mode.",
                  },
                },
                type: "object",
                required: ["mode"],
              },
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "write",
      description:
        "\nCreate and edit files on the filesystem.\n\nSupported commands:\n- create: Create a new file with content\n- update: Apply targeted edits to an existing file using old_string/new_string replacement\n\nFor update, old_string must match exactly one location in the file. Use enough context lines to ensure unique matching.\n",
      inputSchema: {
        json: {
          required: ["command", "path"],
          type: "object",
          properties: {
            command: {
              description: "The write operation to perform",
              enum: ["create", "update"],
              type: "string",
            },
            path: {
              type: "string",
              description: "Path to the file to create or update",
            },
            content: {
              type: "string",
              description: "File content (required for create command)",
            },
            old_string: {
              type: "string",
              description:
                "The exact string to find and replace (required for update command). Must match exactly one location.",
            },
            new_string: {
              type: "string",
              description: "The replacement string (required for update command)",
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "shell",
      description:
        "\nExecute shell commands in a terminal.\n\nProvides access to the system shell for running commands, scripts, and managing processes.\nCommands run in the user's environment with their PATH and environment variables.\n",
      inputSchema: {
        json: {
          required: ["command"],
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute",
            },
            cwd: {
              type: "string",
              description: "Working directory for the command. Defaults to current directory.",
            },
            timeout: {
              type: "integer",
              description: "Command timeout in milliseconds",
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "use_aws",
      description:
        "\nInvoke the AWS CLI to interact with AWS services.\n\nRuns AWS CLI commands using the user's configured credentials and region.\nSupports all AWS services available through the CLI.\n",
      inputSchema: {
        json: {
          required: ["command"],
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The AWS CLI command to execute (without the 'aws' prefix)",
            },
            region: {
              type: "string",
              description: "AWS region override",
            },
            profile: {
              type: "string",
              description: "AWS profile to use",
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "web_search",
      description:
        "\nSearch the web for information.\n\nPerforms a web search and returns relevant results with titles, snippets, and URLs.\nUseful for finding documentation, articles, Stack Overflow answers, and current information.\n",
      inputSchema: {
        json: {
          required: ["query"],
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query",
            },
            max_results: {
              type: "integer",
              description: "Maximum number of results to return",
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "web_fetch",
      description:
        "\nFetch and extract content from a URL.\n\nRetrieves the content of a web page and extracts readable text.\nUseful for reading documentation, blog posts, and reference material.\n",
      inputSchema: {
        json: {
          required: ["url"],
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch content from",
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "knowledge",
      description:
        "A tool for indexing and searching content across chat sessions using semantic search.\n\n## Overview\nThis tool enables persistent storage and retrieval of information using semantic search (MiniLLM) or keyword search (BM25). Content remains available across sessions for later use.\n\n## When to use\n- When users ask to query your knowledge bases or kbs\n- When you need to search previously indexed content\n- When users request to index new content (code, markdown, CSV, PDF, and other text file formats)\n- When exploring unfamiliar content to find relevant information\n- When users ask about topics that might be in indexed knowledge bases\n\n## When not to use\n- When content has not been indexed yet and user hasn't requested indexing\n- When you need real-time or external information not in the knowledge base\n\n## Notes\n- Use 'show' command to list available knowledge bases before searching\n- Search can target specific knowledge bases (context_id) or all knowledge bases\n- Use default limit values unless specifically needed; fewer results for focused search\n- Pagination available via offset parameter for large result sets\n- 'add' command indexes new content; 'update' command refreshes existing knowledge bases\n- Unless there is a clear reason to modify the search query, use the user's original wording for better semantic matching",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            command: {
              enum: [
                "show",
                "add",
                "remove",
                "clear",
                "search",
                "update",
                "status",
                "cancel",
              ],
              type: "string",
              description:
                "The knowledge operation to perform:\n- 'show': List all knowledge contexts (no additional parameters required)\n- 'add': Add content to knowledge base (requires 'name' and 'value')\n- 'remove': Remove content from knowledge base (requires one of: 'name', 'context_id', or 'path')\n- 'clear': Remove all knowledge contexts.\n- 'search': Search across knowledge contexts (requires 'query', optional: 'context_id', 'limit', 'offset', 'snippet_length', 'sort_by', 'file_type')\n- 'update': Update existing context with new content (requires 'path' and one of: 'name', 'context_id')\n- 'status': Show background operation status and progress\n- 'cancel': Cancel background operations (optional 'operation_id' to cancel specific operation, or cancel all if not provided)",
            },
            name: {
              type: "string",
              description:
                "A descriptive name for the knowledge context. Required for 'add' operations. Can be used for 'remove' and 'update' operations to identify the context.",
            },
            value: {
              type: "string",
              description:
                "The content to store in knowledge base. Required for 'add' operations. Can be either text content or a file/directory path. If it's a valid file or directory path, the content will be indexed; otherwise it's treated as text.",
            },
            query: {
              type: "string",
              description:
                "The search query string. Required for 'search' operations. Performs semantic search across knowledge contexts to find relevant content.",
            },
            context_id: {
              type: "string",
              description:
                "The unique context identifier for targeted operations. Can be obtained from 'show' command. Used for 'remove', 'update', and 'search' operations to specify which context to operate on.",
            },
            path: {
              description:
                "File or directory path. Used in 'remove' operations to remove contexts by their source path, and required for 'update' operations to specify the new content location.",
              type: "string",
            },
            limit: {
              type: "integer",
              description:
                "Maximum number of search results to return, use default value unless required more results or focused search. Optional for 'search' operations.",
            },
            offset: {
              description:
                "Number of results to skip for pagination. Optional for 'search' operations.",
              type: "integer",
            },
            snippet_length: {
              type: "integer",
              description:
                "Maximum character length for text snippets in results. Text longer than this will be truncated. Optional for 'search' operations.",
            },
            sort_by: {
              type: "string",
              enum: ["relevance", "path", "name"],
              description:
                "Sort order for search results. Options: 'relevance' (default, by similarity score), 'path' or 'name' (alphabetically by file path). Optional for 'search' operations.",
            },
            file_type: {
              description:
                "Filter results by file type (e.g., 'Code', 'Markdown', 'Text'). Optional for 'search' operations.",
              type: "string",
            },
            operation_id: {
              type: "string",
              description:
                "Optional operation ID to cancel a specific operation. Used with 'cancel' command. If not provided, all active operations will be cancelled. Can be either the full operation ID or the short 8-character ID.",
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
          required: ["command"],
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "todo_list",
      description:
        "\nManage a task list for tracking work items.\n\nSupported commands:\n- show: Display current tasks\n- add: Add a new task\n- update: Update task status or description\n- remove: Remove a task\n- clear: Clear all tasks\n",
      inputSchema: {
        json: {
          required: ["command"],
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The task operation to perform",
              enum: ["show", "add", "update", "remove", "clear"],
            },
            description: {
              type: "string",
              description: "Task description (required for add/update)",
            },
            task_id: {
              type: "string",
              description: "Task ID (required for update/remove)",
            },
            status: {
              type: "string",
              description: "Task status (optional for update)",
              enum: ["pending", "in_progress", "done"],
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "subagent",
      description:
        "\nOrchestrate multiple agents in a pipeline to complete complex tasks.\n\nSpawn subagents that can independently work on subtasks, each with their own context and tools.\nUseful for divide-and-conquer approaches to large problems.\n",
      inputSchema: {
        json: {
          required: ["task"],
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "Description of the task for the subagent",
            },
            context: {
              type: "string",
              description: "Additional context or instructions for the subagent",
            },
            __tool_use_purpose: {
              type: "string",
              description: "A brief explanation why you are making this tool use.",
            },
          },
        },
      },
    },
  },
  {
    toolSpecification: {
      name: "introspect",
      description:
        "\nLook up documentation about this chat application's own features, slash commands, settings, or capabilities.\n\nWHEN TO USE:\n- User asks about this assistant's features, commands, or settings\n- User wants to know what slash commands are available\n- User asks how to use a specific feature of this chat application\n\nWHEN NOT TO USE:\n- General coding questions, AWS help, or tasks the user wants you to perform\n- Questions unrelated to this chat application itself\n\nHOW TO USE:\n- Provide a query to search the documentation\n- Or provide a doc_path to retrieve a specific document\n- When mentioning commands in your response, always prefix them with '/' (e.g., '/chat save', '/chat load', '/context')\n- CRITICAL: Only provide information explicitly documented. If details are not documented, clearly state the information is not available rather than generating assumptions.\n",
      inputSchema: {
        json: {
          required: [],
          type: "object",
          properties: {
            query: {
              description:
                "The user's question about this assistant's usage, features, or capabilities",
              type: "string",
            },
            doc_path: {
              description:
                "Path to a specific doc to retrieve (e.g., \"features/tangent-mode.md\"). Use this to get full content of a doc from the index.",
              type: "string",
            },
            __tool_use_purpose: {
              description: "A brief explanation why you are making this tool use.",
              type: "string",
            },
          },
        },
      },
    },
  },
];
