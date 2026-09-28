---
name: Amazon Q Developer
website: https://aws.amazon.com/q/developer/
tagline: AWS's coding assistant with IDE agents, a command line agent and deep knowledge of AWS services and the console.
vertical: developer-tools
category: Coding assistants
pricing: Freemium
bestFor: Teams building on AWS who want an assistant that understands their cloud account and IAM setup
rating: 3.5
addedDate: 2026-09-28
---

## What is Amazon Q Developer?

Amazon Q Developer is the coding assistant AWS built to replace CodeWhisperer. It provides inline completions and chat inside VS Code, JetBrains, Visual Studio and Eclipse, a command line agent that runs in your terminal, and a chat panel inside the AWS Management Console itself. The distinguishing feature is how much it knows about AWS: ask it why a Lambda function is timing out or how to write an IAM policy for a specific bucket, and it answers with reference to your actual resources rather than generic documentation.

In the IDE, slash commands drive the agents. One takes a feature description and produces a multi-file implementation plan and code. Another generates unit tests for a selected function or file. A third reviews the code you have written for bugs, security issues and style problems. A transformation agent handles Java version upgrades and some .NET migrations, which is a niche but valuable job for enterprises with old codebases. The command line agent understands your shell context, translates natural language into commands, and can execute multi-step tasks with your approval.

The free tier includes completions, chat and a monthly allowance of agent requests, and it works with a plain AWS Builder ID rather than an AWS account. The Pro tier is priced per user per month, is managed through IAM Identity Center, and adds higher limits, admin controls, usage dashboards, customisation on your private code and intellectual property indemnity.

## Where it shines

For AWS-heavy teams, the console and account awareness is the reason to use it. Debugging a permissions error by asking a chat panel that can read the policy in question is faster than the usual cycle of reading CloudTrail and guessing. The assistant also knows AWS SDK and CDK idioms well, so generated infrastructure code tends to be closer to correct than what general-purpose tools produce.

The test generation and code review agents are practical. The review agent in particular catches real security problems in the IDE before code reaches a pull request. The Java transformation agent is the only one of its kind among mainstream assistants and can save weeks on a large legacy upgrade.

Enterprise administration is straightforward if you already run IAM Identity Center. Users are provisioned through the same groups as everything else, spend is on the AWS bill, and the Pro tier's training and indemnity terms are clear.

## Where it falls short

Outside AWS-specific work, the completions and chat are competent but a step behind the leaders. General coding quality on front-end frameworks or unusual languages is noticeably weaker than [Cursor](/tools/cursor/) or [GitHub Copilot](/tools/github-copilot/), and there is no choice of models: you use what AWS provides. The multi-file agent in the IDE is more rigid than the agents in dedicated AI editors, working through a plan and hand-off flow rather than an interactive loop.

The product is also in flux. AWS launched Kiro, a separate agentic editor, and the relationship between the two products has been confusing for customers. Check the current roadmap before standardising on either. The console chat is only as useful as the permissions of the identity you are signed in with, so developers with restricted access get restricted answers. The sign-in flow across Builder ID and Identity Center is also a common source of support tickets.

## Conclusion

Amazon Q Developer earns a place for teams whose work is mostly on AWS, where its knowledge of services, accounts and IAM is something no general-purpose assistant matches. The free tier is a low-risk way to test that claim. For general-purpose coding, or for teams that want model choice and a more fluid agent, the leading editors and assistants are better daily drivers, and many AWS shops end up running both.
