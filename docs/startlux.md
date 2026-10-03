# StartLux 4B Q8

实验台现在支持 Jev、Laya、StartLux 单独或同时运行。StartLux 使用官方 `/v1/systemone` 决策协议，不能用普通聊天接口代替。

## 已准备的本机环境

在项目目录运行 `sh scripts/startlux-service.sh`，保持终端开启。在模型配置中选择 StartLux：

- 完整接口：`http://127.0.0.1:8090/v1/systemone`
- 模型名称：`StartLux-Decision-4B-Q8_0`
- 本机 Key：留空

脚本只监听本机，关闭时清理它自己启动的两个进程。模型、日志、下载缓存均保存在忽略版本控制的 `.local/startlux`。

## 新机器准备

1. 安装 Python 及 `torch`、`transformers`（GGUF 包装器只需 CPU 版 torch）。脚本默认复用 `.venv-laya/bin/python`，也可通过 `STARTLUX_PYTHON` 指定独立环境。
2. 从 [官方 llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) 获取支持当前平台的 b10454 或更新构建。Mac 选 arm64 / Metal。通过 `STARTLUX_LLAMA_SERVER` 指定其可执行文件；本次固定 b11368。
3. 从 [官方 GGUF 仓库](https://huggingface.co/startlux-models/StartLux-Decision-4B-Q8_0-GGUF) 下载完整仓库到 `.local/startlux/model`，包括 tokenizer、decision_config 和 `startlux_decision` 代码。固定 revision：`3e98f4efc5b9f1c9c9232cc40f862a3b872cc33f`。可用 `hf download REPO --revision REVISION --local-dir .local/startlux/model`。
4. 运行启动脚本。默认后端端口 8081、决策端口 8090；确保端口空闲。

权重约 4.48 GB，运行还需要缓冲与系统内存。Mac 16 GB 以上适合短文本低并发，具体峰值与速度应实测。

## 评测口径

- 原生 confidence 定义可能不同；实验台使用选中答案概率作为 Choice 保留依据。
- 整批耗时包含 HTTP、推理、判分和结果保存，按模型组独立计时。
- Jev 云端与本地模型的端到端耗时不能解释为相同硬件下的推理速度差。
- 量化版本和后端版本应与结果一并记录。

权重许可为 CC BY-NC 4.0，商业用途需要另行授权；官方推理代码为 Apache-2.0。本项目不随源码分发权重。
