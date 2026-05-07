#!/usr/bin/env python3
"""
Example usage of the minimal agent.
First, copy .env.example to .env and fill in your API key and PROJECT_ROOT.
"""
import os
from dotenv import load_dotenv
from src.agent import Orchestrator
from src.agent.llm_gateway import PROVIDER_CONFIGS

# Load environment variables
load_dotenv()

def main():
    # Get configuration from environment
    project_root = os.getenv("PROJECT_ROOT", os.getcwd())
    provider = os.getenv("LLM_PROVIDER", "deepseek")

    # Get appropriate API key based on provider
    if provider in PROVIDER_CONFIGS:
        api_key_env = PROVIDER_CONFIGS[provider]["api_key_env"]
    else:
        api_key_env = "OPENAI_API_KEY"
    api_key = os.getenv(api_key_env)

    if not api_key:
        print(f"Error: {api_key_env} not set in .env file")
        return

    # Example task: Create a simple hello world Python script
    task_objective = """
    Create a Python script called hello.py in the project root that prints "Hello from Minimal Agent!" when run.
    Then run the script to verify it works correctly.
    """

    # task_objective = """
    # Add a new file called fab.py that calculates the fabinacci sequence up to the 10th number.
    # """

    # Initialize and run the agent
    agent = Orchestrator(
        project_root=project_root,
        objective=task_objective,
    )

    result = agent.run()
    print("\n" + "="*50)
    print("FINAL RESULT:")
    print(result)

if __name__ == "__main__":
    main()
