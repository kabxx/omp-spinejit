# Spine for OMP (`@kabxx/omp-spinejit`)

[![arXiv](https://img.shields.io/badge/arXiv-2610.37224-b31b1b.svg)](https://arxiv.org/abs/2610.37224) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[English](README.md) | 简体中文

> 本仓库维护 OMP 适配器，底层使用上游 Spine SDK，并附带预构建的 `dist/omp/` 产物，供 GitHub 源码直装使用。[GhabiX/dsh-spinejit 中文 README](https://github.com/GhabiX/dsh-spinejit/blob/5e4f9153a5ad37158600ac71d4a85f1bb8d6310a/README.zh-CN.md) · [Spine SDK](https://github.com/GhabiX/spine-plugin/tree/main/packages/sdk)

**让智能体的上下文与任务树自然对齐。**

长程任务天然是一棵嵌套的子任务树，但智能体的默认上下文却是一条单向堆积的扁平日志。**Spine** 将 OMP 的执行过程统一纳入持久化工作树（**`SpineTree`**）管理。智能体在推理时显式开启、切换和闭合本地子任务（`Open`、`Close`、`Next`），并在需要并行分治时委派子树（`Spawn`）。每次主流程调用模型前，运行时根据 `SpineTree` 即时编译出最小有效上下文——完整保留当前活跃步骤，将已完成的子任务自动折叠为其返回结论，同时保持前序上下文逐字节不变以持续命中前缀缓存。

## 安装命令

用 OMP 内置命令从 npm 安装。

```bash
omp install @kabxx/omp-spinejit
```

也可以从 GitHub 直接安装。

```bash
omp install github:kabxx/omp-spinejit
```

安装后重启 OMP，用 `/new` 开始新会话。可用 `omp plugin list` 验证安装。在智能体开启任务后，任务树会显示在输入框上方，运行 `/spine-tree` 可浏览节点、交接记忆和过往摘要。在安装地址后加 `#<commit>` 可固定到指定提交。

## 兼容性、权限与风险说明

- **能力分类**为记忆与上下文（Memory & Context）。
- **支持宿主**为官方 OMP `19.0.0` 的终端界面。已在 Linux 上验证 GitHub 直装和会话恢复。
- **运行环境**使用 OMP `19.0.0` 和包依赖 `@spinejit/spine-sdk@0.1.4`（SDK v3）。从源码构建需要 Node.js ≥22.19.0 与 Bun ≥1.4.4。
- **权限与外部服务。** 上下文投影基于本地内嵌 Rust/WASM 核心（`@spinejit/spine-sdk`），无需额外 API Key 或第三方服务。模型推理和压缩仍使用 OMP 已配置的模型。
- **已知限制与冲突。** Spine 管理会话上下文投影，请在同一会话只加载一份 Spine 适配器，并停用注册了 `context` 或 `session_before_compact` 钩子的其他扩展。遇到旧版 Spine 记录警告时，保留原会话日志，用 `/new` 新开会话。[OMP 宿主接入说明](doc/HOST.md)
- **上游仓库与论文。** 参见 [GhabiX/spine-plugin](https://github.com/GhabiX/spine-plugin)、[SpineCodex](https://github.com/GhabiX/SpineCodex) 和论文 [arXiv:2610.37224](https://arxiv.org/abs/2610.37224)。

## 许可证

采用 [Apache-2.0](LICENSE) 开源许可证发布。
