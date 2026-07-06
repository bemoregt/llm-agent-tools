#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const OCTAVE_PATH = "octave";
const OUTPUT_DIR = path.join(os.homedir(), "octave-mcp", "outputs");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function runOctave(code, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(OCTAVE_PATH, ["--no-gui", "--eval", code]);

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Octave 실행이 시간 초과되었습니다."));
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function buildPlotWrapper(userCode, imagePath) {
  return `
try
  ${userCode}
  if exist('gcf', 'builtin') || ishandle(gcf)
    print(gcf, '${imagePath}', '-dpng', '-r150');
  end
catch err
  disp(['ERROR: ' err.message]);
end
`;
}

const server = new Server(
  {
    name: "octave-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "run_octave",
        description:
          "Octave 코드를 실행하고 텍스트 결과를 반환합니다. plot 명령이 포함된 경우 그래프를 PNG 파일로 저장하고 경로를 함께 반환합니다.",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "실행할 Octave 코드",
            },
          },
          required: ["code"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "run_octave") {
    throw new Error(`알 수 없는 도구: ${request.params.name}`);
  }

  const userCode = request.params.arguments.code;
  const hasPlot = /\b(plot|surf|mesh|bar|hist|scatter|contour|imagesc)\s*\(/.test(
    userCode
  );

  let finalCode = userCode;
  let imagePath = null;

  if (hasPlot) {
    const fileName = `plot_${crypto.randomUUID()}.png`;
    imagePath = path.join(OUTPUT_DIR, fileName);
    finalCode = buildPlotWrapper(userCode, imagePath);
  }

  try {
    const result = await runOctave(finalCode);

    let resultText = result.stdout.trim();
    if (result.stderr.trim()) {
      resultText += `\n\n[stderr]\n${result.stderr.trim()}`;
    }

    const content = [
      {
        type: "text",
        text: resultText || "(출력 없음)",
      },
    ];

    if (hasPlot && imagePath && fs.existsSync(imagePath)) {
      const imageData = fs.readFileSync(imagePath);
      content.push({
        type: "image",
        data: imageData.toString("base64"),
        mimeType: "image/png",
      });
      content.push({
        type: "text",
        text: `그래프 파일 저장 위치: ${imagePath}`,
      });
    }

    return { content };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `실행 중 오류가 발생했습니다: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("서버 시작 실패:", err);
  process.exit(1);
});
