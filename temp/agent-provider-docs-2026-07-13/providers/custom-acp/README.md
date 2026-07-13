# Custom ACP

Shipped app runtime: yes, as a user-configured route.

This is not a vendor provider. It is an explicit ACP executable/argv/cwd/config
boundary and must never inherit secrets or silently widen permissions.
