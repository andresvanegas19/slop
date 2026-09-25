"""Liquid through OpenRouter as a LangChain chat model. The only LLM factory the agent uses."""
from langchain_openai import ChatOpenAI

OPENROUTER_BASE = "https://openrouter.ai/api/v1"


def liquid_chat_model(settings, timeout_s=90, max_tokens=None, reasoning="low"):
    """LFM 2.5 always reasons first; max_tokens covers reasoning + answer. `max_tokens` goes in extra_body because
    langchain-openai would otherwise send `max_completion_tokens`, which OpenRouter does not document."""
    return ChatOpenAI(
        model=settings.model,
        api_key=settings.openrouter_key,
        base_url=OPENROUTER_BASE,
        temperature=0,
        timeout=timeout_s,
        max_retries=4,  # the openai client backs off on 429/5xx (free-tier rate limits)
        default_headers={"HTTP-Referer": "http://localhost:3000", "X-Title": "Longform company agent"},
        extra_body={"max_tokens": max_tokens or settings.max_tokens, "reasoning": {"effort": reasoning}},
    )
