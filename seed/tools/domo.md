---
name: Domo
website: https://www.domo.com/
tagline: Cloud business intelligence platform combining a large connector library, built-in ETL, dashboards and AI in one product.
vertical: data
category: BI and dashboards
pricing: Paid
bestFor: Business teams that want data integration, transformation and dashboards from a single vendor
rating: 4
addedDate: 2026-09-28
---

## What is Domo?

Domo is a fully cloud-hosted BI platform that tries to own the whole pipeline from source system to executive dashboard. Its connector library is the largest in the category, with more than a thousand prebuilt connectors to SaaS applications, databases, files and APIs, all managed inside Domo rather than through a separate integration tool. Data lands in Domo datasets, gets transformed with Magic ETL, a visual drag-and-drop flow builder, or with SQL dataflows, and is then visualised in cards that are assembled into dashboards.

Around that core Domo has built a wide set of features. Alerts notify people when a metric moves, Buzz provides chat threads attached to cards, Domo Everywhere handles embedding for customers and partners, and Jupyter workspaces give data scientists notebooks inside the platform. Domo.AI adds a chat interface for asking questions of data in plain language and AI-generated summaries of cards. Personalised data permissions filter each dataset by user, and a governance toolkit covers certification, lineage and usage. Pricing is consumption-based, using credits that cover queries, data volume and features, with plans quoted per customer.

## Where it shines

Connectors are the reason people buy Domo. A marketing operations team can connect Salesforce, HubSpot, Google Analytics, Google Ads, Facebook Ads, NetSuite and a few spreadsheets in a day without engineering help, then schedule refreshes and build dashboards on top. For companies without a data engineering function, that is a complete stack from one vendor.

Magic ETL is approachable. Analysts who would never write SQL can join, filter, pivot and clean datasets in a visual flow, and the SQL option exists for those who prefer it. Datasets, dataflows and cards all live in one place with lineage between them, so it is clear where a number came from.

Mobile is unusually good. The iOS and Android apps render dashboards properly, support alerts and let executives drill down on a phone, which matters for a product whose original pitch was the CEO dashboard.

The application layer is broad. App Studio and the Domo App Framework let teams build data applications with write-back, forms and workflows, extending Domo beyond read-only reporting.

## Where it falls short

Cost and cost predictability are the recurring complaints. Consumption pricing is hard to forecast, heavy users of dataflows and large datasets burn credits quickly, and there is no self-serve purchase or public price list. Customers frequently report that the bill grew faster than expected as adoption spread. [Power BI](/tools/power-bi/) and [Metabase](/tools/metabase/) deliver internal dashboards at a small fraction of the cost when the data is already in a warehouse.

Domo wants to be the warehouse. Loading everything into Domo datasets works for mid-sized data but duplicates a warehouse you may already run, and while the Cloud Amplifier feature can query Snowflake and BigQuery in place, the platform is at its best with data copied in. Teams with a modern warehouse and dbt find the built-in ETL redundant and less controllable than their existing pipeline.

Visualisation is competent but not a strength. Card types cover the common cases, yet advanced formatting, custom visuals and ad hoc exploration lag [Tableau](/tools/tableau/) and Qlik Sense. Domo is also cloud-only, with no self-hosted option for regulated environments.

## Conclusion

Domo is the right choice for business-led teams that need to pull data from many SaaS systems, clean it without engineers and put dashboards in front of managers and executives quickly, all from one vendor. The connector library and mobile experience are real advantages. It is the wrong choice for organisations with a mature warehouse and data engineering team, or for anyone who needs predictable per-seat pricing and self-hosting.
