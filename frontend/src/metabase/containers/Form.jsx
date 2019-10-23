/* @flow */

import React from "react";
import PropTypes from "prop-types";

import { connect } from "react-redux";
import { createSelector } from "reselect";
import { reduxForm, getValues, initialize } from "redux-form";
import { getIn, assocIn, dissocIn } from "icepick";
import _ from "underscore";

import CustomForm from "metabase/components/form/CustomForm";
import StandardForm from "metabase/components/form/StandardForm";

export {
  CustomFormField as FormField,
  CustomFormSubmit as FormSubmit,
  CustomFormMessage as FormMessage,
  CustomFormFooter as FormFooter,
  CustomFormSection as FormSection,
} from "metabase/components/form/CustomForm";

type FormFieldName = string;
type FormFieldTitle = string;
type FormFieldDescription = string;
type FormFieldType =
  | "input"
  | "password"
  | "select"
  | "text"
  | "color"
  | "hidden"
  | "collection";

type FormValue = any;
type FormError = string;
type FormValues = { [name: FormFieldName]: FormValue };
type FormErrors = { [name: FormFieldName]: FormError };

export type FormFieldDefinition = {
  name: FormFieldName,
  type?: FormFieldType,
  title?: FormFieldTitle,
  description?: FormFieldDescription,
  initial?: FormValue | (() => FormValue),
  normalize?: (value: FormValue) => FormValue,
  validate?: (value: FormValue, props: FormProps) => ?FormError | boolean,
};

export type FormDefinition = {
  fields:
    | ((values: FormValues) => FormFieldDefinition[])
    // $FlowFixMe
    | FormFieldDefinition[],
  // $FlowFixMe
  initial?: FormValues | (() => FormValues),
  normalize?: (values: FormValues) => FormValues,
  validate?: (values: FormValues, props: FormProps) => FormErrors,
};

type FormObject = {
  fields: (values: FormValues) => FormFieldDefinition[],
  fieldNames: (values: FormValues) => FormFieldName[],
  initial: () => FormValues,
  normalize: (values: FormValues) => FormValues,
  validate: (values: FormValues, props: FormProps) => FormErrors,
};

type FormProps = {
  values?: FormValues,
};

type Props = {
  form: FormDefinition,
  initialValues?: ?FormValues,
  formName?: string,
  onSubmit: (values: FormValues) => Promise<any>,
  formComponent?: React$Component<any, any, any>,
};

type State = {
  inlineFields: { [name: FormFieldName]: FormFieldDefinition },
};

let FORM_ID = 0;
const makeMapStateToProps = () => {
  let formName;
  return (state, ownProps) => {
    return {
      formName:
        ownProps.formName || (formName = formName || `form_${FORM_ID++}`),
      values: getValues(state.form[formName]),
    };
  };
};

const ReduxFormComponent = reduxForm()(props => {
  const FormComponent =
    props.formComponent || (props.children ? CustomForm : StandardForm);
  return <FormComponent {...props} />;
});

@connect(makeMapStateToProps)
export default class Form extends React.Component {
  props: Props;
  state: State;

  _submitting: boolean = false;
  _submitFailed: boolean = false;

  _getFormDefinition: () => FormDefinition;
  _getFormObject: () => FormObject;
  _getInitialValues: () => FormValues;
  _getFieldNames: () => FormFieldName[];

  constructor(props: Props) {
    super(props);

    this.state = {
      // fields defined via child FormField elements
      inlineFields: {},
    };

    // memoized functions
    const getFormDefinition = createSelector(
      [
        (state, props) => props.form,
        (state, props) => props.validate,
        (state, props) => props.initial,
        (state, props) => props.normalize,
        (state, props) => state.inlineFields,
      ],
      (form, validate, initial, normalize, inlineFields) =>
        // use props.form if provided, otherwise generate from state.fields and props.{validate,initial,normalize}
        form || {
          validate,
          initial,
          normalize,
          fields: Object.values(inlineFields),
        },
    );
    const getFormObject = createSelector(
      [getFormDefinition],
      formDef => makeFormObject(formDef),
    );
    const getInitialValues = createSelector(
      [getFormObject, (state, props) => props.initialValues || {}],
      (formObject, initialValues) => ({
        ...formObject.initial(),
        ...initialValues,
      }),
    );
    const getFieldNames = createSelector(
      [getFormObject, getInitialValues, (state, props) => props.values || {}],
      (formObject, initialValues, values) =>
        formObject.fieldNames({
          ...initialValues,
          ...values,
        }),
    );
    this._getFormObject = () => getFormObject(this.state, this.props);
    this._getFormDefinition = () => getFormDefinition(this.state, this.props);
    this._getInitialValues = () => getInitialValues(this.state, this.props);
    this._getFieldNames = () => getFieldNames(this.state, this.props);
  }

  static propTypes = {
    form: PropTypes.object.isRequired,
    onSubmit: PropTypes.func.isRequired,
    initialValues: PropTypes.object,
    formName: PropTypes.string,
  };

  static childContextTypes = {
    registerFormField: PropTypes.func,
    unregisterFormField: PropTypes.func,
    fieldNames: PropTypes.array,
  };

  componentDidUpdate(prevProps: Props, prevState: State) {
    if (!this.props.form) {
      // HACK: when new fields are added they aren't initialized with their intialValues, so we have to force it here:
      const newFields = _.difference(
        Object.keys(this.state.inlineFields),
        Object.keys(prevState.inlineFields),
      );
      if (newFields.length > 0) {
        // $FlowFixMe: dispatch provided by connect
        this.props.dispatch(
          initialize(
            this.props.formName,
            this._getInitialValues(),
            this._getFieldNames(),
          ),
        );
      }
    }
  }

  _registerFormField = (field: FormFieldDefinition) => {
    if (!_.isEqual(this.state.inlineFields[field.name], field)) {
      // console.log("_registerFormField", field.name);
      this.setState(prevState =>
        assocIn(prevState, ["inlineFields", field.name], field),
      );
    }
  };

  _unregisterFormField = (field: FormFieldDefinition) => {
    if (this.state.inlineFields[field.name]) {
      // console.log("_unregisterFormField", field.name);
      this.setState(prevState =>
        dissocIn(prevState, ["inlineFields", field.name]),
      );
    }
  };

  getChildContext() {
    return {
      registerFormField: this._registerFormField,
      unregisterFormField: this._unregisterFormField,
    };
  }

  _validate = (values: FormValues, props: any) => {
    // HACK: clears failed state for global error
    if (!this._submitting && this._submitFailed) {
      this._submitFailed = false;
      props.dispatch(props.stopSubmit(this.props.formName));
    }
    const formObject = this._getFormObject();
    return formObject.validate(values, props);
  };

  _onSubmit = async (values: FormValues) => {
    const formObject = this._getFormObject();
    // HACK: clears failed state for global error
    this._submitting = true;
    try {
      const normalized = formObject.normalize(values);
      return await this.props.onSubmit(normalized);
    } catch (error) {
      console.error("Form submission error", error);
      this._submitFailed = true;
      // redux-form expects { "FIELD NAME": "FIELD ERROR STRING" } or {"_error": "GLOBAL ERROR STRING" }
      if (error && error.data && error.data.errors) {
        throw error.data.errors;
      } else if (error) {
        throw {
          _error: error.data.message || error.data,
        };
      }
    } finally {
      setTimeout(() => (this._submitting = false));
    }
  };

  render() {
    // eslint-disable-next-line
    const { formName } = this.props;
    const formObject = this._getFormObject();
    const initialValues = this._getInitialValues();
    const fieldNames = this._getFieldNames();
    return (
      <ReduxFormComponent
        {...this.props}
        formObject={formObject}
        // redux-form props:
        form={formName}
        fields={fieldNames}
        initialValues={initialValues}
        validate={this._validate}
        onSubmit={this._onSubmit}
      />
    );
  }
}

// returns a function that takes an object
// apply the top level method (if any) to the whole object
// then apply each field's method (if any) to each value in object, setting the result if not undefined
//
// equivalent examples:
//
// form.initial is { foo: "bar" }
// form.initial is () => ({ foo: "bar" })
// form.fields[0] is { name: "foo", initial: "bar" }
// form.fields[0] is { name: "foo", initial: () => "bar" }
//
function makeFormMethod(
  form: FormObject,
  methodName: string,
  defaultValues: any = {},
  mergeFn,
) {
  const originalMethod = form[methodName];
  form[methodName] = (object, ...args) => {
    // make a copy
    const values = {
      ...(getValue(originalMethod, object, ...args) ||
        getValue(defaultValues, object, ...args)),
    };
    for (const field of form.fields(object)) {
      const value = getValue(
        field[methodName],
        object && getValueAtPath(object, field.name),
        ...args,
      );
      if (value !== undefined) {
        setValueAtPath(values, field.name, value, mergeFn);
      }
    }
    return values;
  };
}
// if the first arg is a function, call it, otherwise return it.
function getValue(fnOrValue, ...args): any {
  return typeof fnOrValue === "function" ? fnOrValue(...args) : fnOrValue;
}
function makeFormObject(formDef: FormDefinition): FormObject {
  const form = {
    ...formDef,
    fields: values => getValue(formDef.fields, values),
    fieldNames: values => [
      "id",
      ...form.fields(values).map(field => field.name),
    ],
  };
  // for validating the object, or individual values
  makeFormMethod(form, "validate", {}, (a, b) =>
    [a, b].filter(a => a).join(", "),
  );
  // for getting the initial values object, or getting individual values
  makeFormMethod(form, "initial");
  // for normalizeing the object before submitting, or normalizeing individual values
  makeFormMethod(form, "normalize", object => object);
  return form;
}

function getObjectPath(path) {
  return typeof path === "string" ? path.split(".") : path;
}

function getValueAtPath(object, path) {
  return getIn(object, getObjectPath(path));
}
function setValueAtPath(object, path, value, mergeFn = (a, b) => b) {
  path = getObjectPath(path);
  for (let i = 0; i < path.length; i++) {
    if (i === path.length - 1) {
      object[path[i]] = mergeFn(object[path[i]], value);
    } else {
      object = object[path[i]] = object[path[i]] || {};
    }
  }
}
