.PHONY: install uninstall package test-install
PYTHON ?= python3

install:
	$(PYTHON) scripts/install/install.py install

uninstall:
	$(PYTHON) scripts/install/install.py uninstall

package:
	$(PYTHON) scripts/install/install.py package

test-install:
	$(PYTHON) -m unittest discover -s tests/functional/install -p 'test_*.py'
