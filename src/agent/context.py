from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field

class Message(BaseModel):
    """Single message in the conversation history"""
    role: str = Field(description="Role of the message sender: 'system', 'user', 'assistant', 'tool'")
    content: str = Field(description="Content of the message")
    tool_call_id: Optional[str] = Field(default=None, description="ID of tool call this result is for")
    tool_calls: Optional[List[Dict[str, Any]]] = Field(default=None, description="Tool calls from assistant")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")

class ContextManager:
    """Manages conversation history and context windowing"""
    def __init__(self, max_history_length: int = 20, max_message_length: int = 2000):
        self.max_history_length = max_history_length  # Maximum number of message pairs to keep
        self.max_message_length = max_message_length  # Maximum length per message (truncate longer)
        self.history: List[Message] = []
        self.system_prompt: Optional[str] = None

    def set_system_prompt(self, prompt: str) -> None:
        """Set the system prompt for the conversation"""
        self.system_prompt = prompt

    def add_message(self, role: str, content: str, metadata: Optional[Dict[str, Any]] = None, tool_call_id: Optional[str] = None, tool_calls: Optional[List[Dict[str, Any]]] = None) -> None:
        """Add a message to the history"""
        # Truncate long messages
        if len(content) > self.max_message_length:
            truncated = content[:self.max_message_length] + f"\n[Truncated - original length: {len(content)} characters]"
            content = truncated

        self.history.append(Message(role=role, content=content, tool_call_id=tool_call_id, tool_calls=tool_calls, metadata=metadata or {}))
        # Trim history if it exceeds max length
        self._trim_history()

    def add_tool_result(self, tool_name: str, success: bool, content: str, tool_call_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Helper method to add a tool result message"""
        status = "success" if success else "failed"
        formatted_content = f"Tool '{tool_name}' execution {status}:\n{content}"
        self.add_message(role="tool", content=formatted_content, tool_call_id=tool_call_id, metadata=metadata or {})

    def _trim_history(self) -> None:
        """Trim history to maintain max length, keeping the most recent messages"""
        if len(self.history) > self.max_history_length:
            # Preserve the first message (task objective) so the agent never
            # forgets what it was asked to do, then keep the most recent messages.
            first = self.history[:1]
            self.history = first + self.history[-(self.max_history_length - 1):]

    def get_prompt_messages(self) -> List[Dict[str, Any]]:
        """Get messages formatted for LLM API call"""
        messages = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        # Add conversation history
        for msg in self.history:
            msg_dict = {"role": msg.role, "content": msg.content}
            if msg.tool_call_id:
                msg_dict["tool_call_id"] = msg.tool_call_id
            if msg.tool_calls:
                msg_dict["tool_calls"] = msg.tool_calls
            messages.append(msg_dict)
        return messages

    def clear(self) -> None:
        """Clear all history except system prompt"""
        self.history = []

    def get_history_summary(self) -> str:
        """Get a summary of the conversation history for debugging"""
        summary = [f"Total messages: {len(self.history)}"]
        for i, msg in enumerate(self.history):
            summary.append(f"  [{i}] {msg.role}: {len(msg.content)} chars")
        return "\n".join(summary)

    def serialize(self) -> Dict[str, Any]:
        """Serialize context to dictionary for persistence"""
        return {
            "system_prompt": self.system_prompt,
            "max_history_length": self.max_history_length,
            "max_message_length": self.max_message_length,
            "history": [msg.model_dump() for msg in self.history]
        }

    @classmethod
    def deserialize(cls, data: Dict[str, Any]) -> 'ContextManager':
        """Deserialize context from dictionary"""
        ctx = cls(
            max_history_length=data.get("max_history_length", 20),
            max_message_length=data.get("max_message_length", 2000)
        )
        ctx.system_prompt = data.get("system_prompt")
        ctx.history = [Message(**msg_data) for msg_data in data.get("history", [])]
        return ctx
