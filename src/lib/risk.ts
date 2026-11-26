import type { RiskTag } from "./types";

/**
 * 风险标签的展示文案，规范页、插件卡片和详情页共用这一份。
 * 标签名一律用人话，原始 key 只在规范页里单独展示。
 */
export const riskLabels: Record<RiskTag, string> = {
  filesystem: "文件系统",
  network: "网络访问",
  account: "账号相关",
  automation: "模拟操作",
  ocr: "文字识别",
  yolo: "目标检测",
  clipboard: "系统剪贴板",
  process: "系统进程"
};

export const riskDescriptions: Record<RiskTag, string> = {
  filesystem: "读写插件自身目录以外的文件或系统路径",
  network: "发送外网 HTTP 请求或建立 Socket 网络连接",
  account: "涉及账号凭据管理、密码输入或敏感配置",
  automation: "模拟键盘点击、鼠标移动与自动化挂机",
  ocr: "使用 OCR 引擎解析游戏画面中的文字",
  yolo: "使用深度学习模型定位游戏画面特征",
  clipboard: "读取或修改系统剪贴板数据",
  process: "探测、打开或交互游戏与第三方系统进程"
};
