import os
import re
from urllib.parse import quote
from runtime_env import load_dotenv

load_dotenv()

# 项目根路径（无论你在哪里运行）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 从 .env 获取 DATA_DIR，相对于 BASE_DIR 解析
DATA_DIR_NAME = os.getenv("DATA_DIR", "data")
DATA_DIR = os.path.join(BASE_DIR, DATA_DIR_NAME)
SAVE_PATH = os.path.join(DATA_DIR, "note_output")
IMAGE_BASE_URL = os.getenv("IMAGE_BASE_URL")
STATIC_BASE = os.path.join(BASE_DIR, IMAGE_BASE_URL)


class ExportUtils:
    def __init__(self, **kwargs):
        # 确认SAVE_PATH存在
        print(f"保存路径: {SAVE_PATH}")
        print(f"静态文件路径: {STATIC_BASE}")
        if not os.path.exists(SAVE_PATH):
            os.makedirs(SAVE_PATH)

    def _embed_image_as_base64(self, img_path: str) -> str:
        """
        将图片转换为 base64 格式嵌入
        """
        import base64
        import mimetypes

        try:
            # 获取 MIME 类型
            mime_type, _ = mimetypes.guess_type(img_path)
            if not mime_type:
                # 根据扩展名推断
                ext = os.path.splitext(img_path)[1].lower()
                mime_map = {
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.bmp': 'image/bmp',
                    '.webp': 'image/webp',
                    '.svg': 'image/svg+xml'
                }
                mime_type = mime_map.get(ext, 'image/png')

            # 读取图片文件并转换为 base64
            with open(img_path, 'rb') as f:
                img_data = f.read()

            base64_data = base64.b64encode(img_data).decode('utf-8')
            return f"data:{mime_type};base64,{base64_data}"

        except Exception as e:
            print(f"图片 base64 编码失败 {img_path}: {str(e)}")
            return None

    def _get_normalized_path(self, path: str) -> str:
        """
        获取规范化的绝对路径
        """
        return os.path.normpath(os.path.abspath(path))

    def _replace_static_paths_with_absolute(self, content: str) -> str:
        """
        将 Markdown 中的图片路径替换为 base64 内嵌格式
        这样可以确保图片在 PDF 中正确显示
        """

        def repl(match):
            # 捕获 alt 文本和路径
            alt_text = match.group(1) if match.group(1) else ""
            img_path = match.group(2).strip()

            print(f"处理图片路径: {img_path}")

            # 处理 /static/ 开头的路径
            if img_path.startswith("/static/"):
                # 构建绝对路径
                relative_path = img_path.lstrip("/")  # 移除开头的 /
                abs_path = os.path.join(BASE_DIR, relative_path)
                abs_path = self._get_normalized_path(abs_path)

                # 检查文件是否存在并转换为 base64
                if os.path.exists(abs_path):
                    base64_uri = self._embed_image_as_base64(abs_path)
                    if base64_uri:
                        print(f"图片转换为 base64 成功: {img_path}")
                        return f"![{alt_text}]({base64_uri})"
                    else:
                        print(f"图片 base64 转换失败: {abs_path}")
                        return f"![{alt_text}](图片转换失败: {img_path})"
                else:
                    print(f"警告：图片文件不存在 {abs_path}")
                    return f"![{alt_text}](图片不存在: {img_path})"

            # 处理相对路径（相对于 STATIC_BASE）
            elif not img_path.startswith(('http://', 'https://', 'data:')):
                # 尝试多个可能的路径
                possible_paths = [
                    os.path.join(STATIC_BASE, img_path),
                    os.path.abspath(img_path),
                    os.path.join(BASE_DIR, img_path)
                ]

                for abs_path in possible_paths:
                    abs_path = self._get_normalized_path(abs_path)
                    if os.path.exists(abs_path):
                        base64_uri = self._embed_image_as_base64(abs_path)
                        if base64_uri:
                            print(f"相对路径图片转换为 base64 成功: {img_path}")
                            return f"![{alt_text}]({base64_uri})"
                        break

                print(f"警告：图片文件未找到 {img_path}")
                return f"![{alt_text}](图片未找到: {img_path})"

            # HTTP/HTTPS 和 data: 路径保持不变
            elif img_path.startswith(('http://', 'https://', 'data:')):
                print(f"网络图片或 data URI 保持不变: {img_path[:50]}...")
                return match.group(0)

            # 其他情况保持不变
            return match.group(0)

        # 使用更精确的正则表达式匹配图片语法
        # 匹配 ![alt text](path) 格式
        pattern = r'!\[([^\]]*)\]\(([^)]+)\)'
        result = re.sub(pattern, repl, content)

        print("图片路径处理完成")
        return result

    def export(self, output_format: str, title: str, content: str) -> str:
        """
        导出内容为指定格式
        支持格式：html, word/docx, image/png
        """
        content = content.strip()

        # 处理图片路径
        print("开始处理图片路径...")
        content = self._replace_static_paths_with_absolute(content)

        output_format = output_format.lower()

        try:
            if output_format == "html":
                save_path = self._to_html(content, title)
            elif output_format in ["word", "docx"]:
                save_path = self._to_word(content, title)
            elif output_format in ["image", "png"]:
                save_path = self._to_image(content, title)
            else:
                supported_formats = ["html", "word/docx", "image/png"]
                raise ValueError(f"不支持的导出格式: {output_format}. 支持的格式: {', '.join(supported_formats)}")

            print(f"导出完成: {save_path}")
            return save_path

        except Exception as e:
            print(f"导出失败: {str(e)}")
            raise e

    def get_supported_formats(self):
        """
        返回支持的导出格式列表
        """
        return {
            "html": "HTML 网页",
            "word": "Word 文档 (.docx)",
            "docx": "Word 文档 (.docx)",
            "image": "PNG 图片",
            "png": "PNG 图片"
        }
    def debug_paths(self):
        """
        调试方法：打印重要路径信息
        """
        print("=== 路径调试信息 ===")
        print(f"BASE_DIR: {BASE_DIR}")
        print(f"DATA_DIR: {DATA_DIR}")
        print(f"SAVE_PATH: {SAVE_PATH}")
        print(f"STATIC_BASE: {STATIC_BASE}")
        print(f"IMAGE_BASE_URL: {IMAGE_BASE_URL}")
        print("==================")
