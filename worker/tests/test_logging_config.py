from citemind_worker.logging_config import redact


def test_redact_secrets() -> None:
    assert redact("ark_api_key=secret") == "ark_api_key=[REDACTED]"
    assert redact("Authorization: Bearer token") == "Authorization: Bearer [REDACTED]"
