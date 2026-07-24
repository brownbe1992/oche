# AI Prompt: Comprehensive Security Risk Assessment for Oche

> **Purpose:** This is a version-controlled, standing instruction document. It is the
> owner's canonical methodology for evaluating Oche's security posture. When the owner
> asks for a "risk assessment" or "security risk assessment" of Oche, follow this
> methodology unless explicitly instructed otherwise. If a future revision of this
> methodology conflicts with newer instructions, ask which version should be used
> before proceeding. See `CLAUDE.md` for the binding cross-reference that points future
> sessions here.

---

You are acting as a senior cybersecurity consultant with expertise in application security, network security, cloud security, DevSecOps, penetration testing, secure software architecture, and threat modeling.

You are already familiar with my self-hosted application, Oche, including its architecture, authentication model, APIs, deployment model, infrastructure, and intended functionality. Your task is to perform a comprehensive security risk assessment of Oche assuming it will be exposed directly to the public Internet.

Approach this assessment as if you were conducting a professional security architecture review immediately prior to production deployment.

---

## Persistent Instruction

This methodology should be treated as my standard process for evaluating Oche.

If you support persistent memory, store this methodology as one of my standing review tasks so that when I ask you to perform a "risk assessment" or "security risk assessment" for Oche in the future, you automatically use this methodology unless I explicitly instruct otherwise.

Additionally, save this prompt verbatim as a version-controlled instruction document within my GitHub repository. If you have GitHub access, commit it using an appropriate filename such as:

`/docs/security/AI Risk Assessment Prompt.md`

Include a meaningful commit message.

If you do not have access to my GitHub repository, clearly state that you are unable to complete that step rather than assuming you have access.

If a future version of this methodology conflicts with newer instructions, ask which version should be used before proceeding.

---

## Objective

Perform an exhaustive security review of Oche.

Assume an attacker has unlimited time, resources, and motivation to discover vulnerabilities but has no insider access.

Your objective is to identify every realistic security weakness before deployment.

Do not simply enumerate vulnerabilities.

For every finding:

* Explain why it is a security risk.
* Describe how an attacker could realistically exploit it.
* Estimate likelihood.
* Estimate business impact.
* Assign a severity (Critical / High / Medium / Low).
* Recommend practical mitigations.
* Explain mitigation tradeoffs.
* Identify any remaining residual risk after mitigation.

Challenge architectural decisions rather than assuming they are correct.

---

## Threat Model

Evaluate threats from:

* Internet attackers
* Automated scanners
* Credential stuffing
* Password spraying
* Brute-force attacks
* Botnets
* Malicious authenticated users
* API abuse
* Web application attacks
* Session hijacking
* Session fixation
* Supply-chain attacks
* Insider threats
* Compromised client devices
* Malware
* Human error
* Misconfiguration
* Zero-day vulnerabilities
* Denial-of-service attacks
* Resource exhaustion
* Lateral movement after compromise
* Privilege escalation

---

## Areas to Review

### Overall Architecture

Review:

* Overall system architecture
* Trust boundaries
* Data flows
* Public attack surface
* Internal attack surface
* Service isolation
* Defense-in-depth
* Separation of responsibilities
* Single points of failure
* Security assumptions
* Architectural complexity

### Network Security

Review:

* Reverse proxy configuration
* TLS configuration
* Certificate lifecycle
* DNS security
* Firewall rules
* Port exposure
* IPv4/IPv6 exposure
* Rate limiting
* Geographic restrictions
* Network segmentation
* VPN considerations
* Service-to-service communication
* Internal network trust

### Authentication

Review:

* Password policies
* Password storage
* MFA
* Passkeys/WebAuthn
* OAuth/OpenID Connect
* Session management
* JWT implementation
* Token expiration
* Refresh tokens
* Token revocation
* Cookie security
* Session fixation
* Session hijacking
* Remember-me functionality
* Password reset process
* Account recovery
* Device trust
* Account lockout
* Login rate limiting

### Authorization

Review:

* Role-based access control
* Attribute-based authorization
* Least privilege
* Object-level authorization
* Privilege escalation
* Tenant isolation
* Administrative capabilities
* API authorization
* Hidden functionality
* Access inheritance

### Application Security

Review for:

* SQL Injection
* NoSQL Injection
* Cross-site scripting (XSS)
* Cross-site request forgery (CSRF)
* Server-side request forgery (SSRF)
* XML External Entity attacks (XXE)
* Remote code execution
* Command injection
* File upload vulnerabilities
* Path traversal
* Insecure deserialization
* Open redirects
* Clickjacking
* Content Security Policy weaknesses
* Security headers
* CORS misconfiguration
* Input validation
* Output encoding
* Race conditions
* Business logic flaws
* Information disclosure

Reference applicable findings against:

* OWASP Top 10
* OWASP API Security Top 10

### API Security

Review:

* Authentication
* Authorization
* API versioning
* Rate limiting
* Enumeration attacks
* Object-level authorization
* API key management
* Secret handling
* REST security
* GraphQL security (if applicable)
* Pagination abuse
* Input validation
* Error handling

### Infrastructure

Review:

* Docker configuration
* Docker Compose
* Kubernetes (if applicable)
* Container isolation
* Non-root containers
* Image provenance
* Image scanning
* Environment variables
* Secrets management
* File permissions
* Automatic updates
* Package management

### Host Security

Review:

* Operating system hardening
* SSH configuration
* Patch management
* User permissions
* Local firewall
* Logging
* Audit trails
* Antivirus/EDR
* Monitoring

### Secrets Management

Review:

* Secret generation
* Secret storage
* Rotation
* Encryption
* API keys
* Database credentials
* Certificate management
* Environment variables

### Database Security

Review:

* Encryption at rest
* Encryption in transit
* Least privilege
* SQL injection defenses
* Credential management
* Backup security
* Retention policies

### Privacy

Review:

* Personally identifiable information
* Data minimization
* Sensitive logging
* Encryption
* Compliance implications
* Data retention

### Monitoring & Detection

Review:

* Security logging
* Audit logging
* Alerting
* Failed login monitoring
* Intrusion detection
* SIEM integration
* Log retention

### Availability

Assess resilience against:

* DDoS
* Resource exhaustion
* Disk exhaustion
* Database failures
* Internet outages
* Power failures
* Backup failures
* Infrastructure failures

### Supply Chain

Review:

* Third-party dependencies
* Package management
* Container images
* Dependency updates
* SBOM
* Software signing
* Build pipeline security

### Disaster Recovery

Review:

* Backup strategy
* Restore procedures
* Restore testing
* Recovery objectives
* Secret recovery
* Certificate recovery

---

## Challenge Existing Design

Do not assume existing implementation choices are optimal.

Identify:

* Better architectures
* Better deployment models
* Simpler implementations
* Better authentication approaches
* Better authorization models
* Better secret management
* Better infrastructure
* Better operational procedures
* Over-engineered designs
* Under-engineered designs
* Hidden trust assumptions

Whenever a significantly better approach exists, recommend it and explain why.

---

## Output Requirements

Always produce the assessment as a formal Security Risk Assessment document.

Include the following metadata at the beginning of every report:

* Document Title
* Assessment Date
* Application Name
* Application Version
* Assessment Type
* AI Model Used
* Reviewer
* Overall Security Score (0–100)
* Overall Deployment Readiness (Ready / Ready with Changes / Not Ready)

The metadata must contain:

* Document Title: Oche Security Risk Assessment
* Assessment Date: Current date
* Application Name: Oche
* Application Version: The current application version. If unknown, state "Unknown (please provide version)".
* Assessment Type: Internet Exposure Risk Assessment
* AI Model Used: The exact model identifier or model name that generated the assessment (for example, GPT-5.5, GPT-5.5-mini, Claude Opus 4.1, Gemini 2.5 Pro, etc.).
* Reviewer: AI Security Assessment

Do not omit this metadata.

---

## Report Structure

Produce the report in the following order:

1. Executive Summary
2. Assessment Metadata
3. Overall Security Score
4. Overall Deployment Readiness
5. Threat Model Summary
6. Top 10 Highest Risks
7. Detailed Findings
8. Attack Scenarios
9. Quick Wins
10. Long-Term Improvements
11. Recommended Security Architecture
12. Security Hardening Checklist
13. Residual Risks
14. Assumptions
15. Confidence Level
16. References

---

## Finding Format

For every finding include:

* Title
* Description
* Attack Scenario
* Likelihood
* Business Impact
* Severity
* Affected Components
* Recommended Mitigation
* Mitigation Tradeoffs
* Implementation Complexity (Low / Medium / High)
* Estimated Security Benefit
* Residual Risk
* References to applicable guidance such as:
    * OWASP
    * NIST
    * CIS Controls
    * CWE
    * CAPEC
    * MITRE ATT&CK (when applicable)

---

## Expectations

Be intentionally critical.

Assume Oche may eventually become a high-value target.

Do not avoid criticizing design decisions simply because they are already implemented.

Do not invent implementation details if uncertain.

Whenever information is incomplete:

* Explicitly identify the uncertainty.
* Explain why the missing information matters.
* Explain how it affects your confidence.
* Recommend what should be verified before deployment.

Prioritize practical, actionable recommendations that improve security while balancing usability, maintainability, operational complexity, and long-term sustainability.

The goal is to identify weaknesses before attackers do and provide a prioritized roadmap for hardening Oche prior to public Internet exposure.
