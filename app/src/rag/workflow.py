import os
from typing import Annotated

from llama_index.core import Settings, SimpleDirectoryReader, VectorStoreIndex
from llama_index.core.llms import LLM
from llama_index.core.schema import NodeWithScore
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI
from pydantic import ConfigDict
from workflows import Context, Workflow, step
from workflows.events import Event, StartEvent, StopEvent
from workflows.resource import Resource


def _default_llm_model() -> str:
    return os.environ.get("OPENAI_MODEL", "gpt-5.4")


def _default_embedding_model() -> str:
    return os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")


def ensure_openai_settings() -> None:
    """Configure global LlamaIndex settings for OpenAI LLM + embeddings (reads OPENAI_API_KEY from env)."""
    Settings.llm = OpenAI(model=_default_llm_model())
    Settings.embed_model = OpenAIEmbedding(model=_default_embedding_model())


class IndexCreatedEvent(Event):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    index: VectorStoreIndex


class RetrievalEvent(Event):
    documents: list[NodeWithScore]


async def get_llm(*args, **kwargs) -> LLM:
    ensure_openai_settings()
    return Settings.llm  # type: ignore[return-value]


class RAGWorkflow(Workflow):
    @step
    async def document_processing_step(
        self, ev: StartEvent, ctx: Context
    ) -> IndexCreatedEvent:
        if not os.getenv("OPENAI_API_KEY"):
            raise ValueError(
                "OPENAI_API_KEY must be set (e.g. via .env or Docker env_file)"
            )
        ensure_openai_settings()
        async with ctx.store.edit_state() as state:
            state.query = ev.query
        docs = await SimpleDirectoryReader(ev.path).aload_data()
        index = VectorStoreIndex.from_documents(documents=docs)
        return IndexCreatedEvent(index=index)

    @step
    async def retrieve_step(
        self, ev: IndexCreatedEvent, ctx: Context
    ) -> RetrievalEvent:
        state = await ctx.store.get_state()
        retrieved_documents = await ev.index.as_retriever(top_k=5).aretrieve(
            state.query
        )
        return RetrievalEvent(documents=retrieved_documents)

    @step
    async def generate_step(
        self, ev: RetrievalEvent, llm: Annotated[LLM, Resource(get_llm)], ctx: Context
    ) -> StopEvent:
        state = await ctx.store.get_state()
        docs = "\n\n---\n\n".join(
            [
                f"Content: {node.text}\nScore: {node.score if node.score else -1}"
                for node in ev.documents
            ]
        )
        prompt = (
            f"Based on these documents:\n\n```md\n{docs}\n```\n\n"
            f"Answer this query: {state.query}"
        )
        response = await llm.acomplete(prompt)
        return StopEvent(result=response.text)


workflow = RAGWorkflow(timeout=None)


async def main(path: str, query: str):
    w = RAGWorkflow(timeout=300)
    result = await w.run(path=path, query=query)
    print(str(result))


if __name__ == "__main__":
    import argparse
    import asyncio

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-p",
        "--path",
        help="Path to the directory with the files to ingest",
        required=True,
    )
    parser.add_argument("-q", "--query", help="Retrieval query", required=True)
    args = parser.parse_args()

    if not os.getenv("OPENAI_API_KEY", None):
        raise ValueError(
            "You need to set OPENAI_API_KEY in your environment before using this workflow"
        )

    asyncio.run(main(args.path, args.query))
