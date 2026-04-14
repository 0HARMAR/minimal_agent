from setuptools import setup, find_packages

setup(
    name="minimal_agent",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "anthropic>=0.34.0",
        "openai>=1.0.0",
        "pydantic>=2.6.0",
        "python-dotenv>=1.0.0",
    ],
    author="Your Name",
    description="Minimal educational implementation of an autonomous coding agent",
    python_requires=">=3.10",
)
