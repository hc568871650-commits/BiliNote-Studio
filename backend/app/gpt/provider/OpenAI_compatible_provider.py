from typing import Optional, Union

from app.utils.logger import get_logger
from app.utils.openai_client import build_openai_client

logging= get_logger(__name__)
class OpenAICompatibleProvider:
    def __init__(self, api_key: str, base_url: str, model: Union[str, None]=None):
        # build_openai_client：注入全局代理 + 校验 api_key 非空
        self.client = build_openai_client(api_key, base_url, key_label="模型供应商的 API Key")
        self.model = model

    @property
    def get_client(self):
        return self.client

    @staticmethod
    def test_connection(api_key: str, base_url: str, model: str) -> bool:
        """发一条最小化 chat completion 验证 key / base_url / model 三方都通。

        为什么不用 client.models.list()：
          - 部分代理 / 自建供应商不实现 /v1/models（如某些 OpenAI 兼容网关）
          - 部分供应商 key 在没有 inference 权限时 /v1/models 仍返回 200
        最终用户跑的就是 chat.completions.create，所以直接测它最忠实。
        使用有限输出预算并检查可见回答；推理模型可能先消耗推理 token。
        实际耗时和费用由上游决定，不保证固定延迟或价格。
        """
        try:
            client = build_openai_client(
                api_key, base_url, key_label="模型供应商的 API Key", timeout=60.0,
            )
            response = client.with_options(max_retries=0).chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "Reply with OK only."}],
                max_tokens=256,
                temperature=0,
            )
            if not response.choices or not (response.choices[0].message.content or '').strip():
                raise ValueError("上游未返回可见文本；请检查模型是否支持聊天、输出预算或上游路由")
            logging.info(f"连通性测试成功（model={model}）")
            return True
        except Exception as e:
            from app.utils.model_errors import model_error
            detail = model_error(e, api_key)
            logging.warning(f"连通性测试失败（model={model}）：{detail}")
            raise ValueError(detail) from None
        finally:
            if 'client' in locals():
                client.close()
