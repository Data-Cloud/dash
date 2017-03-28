/* global fetch:true */
import {
    concat,
    contains,
    has,
    intersection,
    isEmpty,
    keys,
    lensPath,
    reject,
    sort,
    type,
    union,
    view
} from 'ramda';
import {createAction} from 'redux-actions';
import {crawlLayout, hasId} from '../reducers/utils';

export const ACTIONS = (action) => {
    const actionList = {
        ON_PROP_CHANGE: 'ON_PROP_CHANGE',
        SET_REQUEST_QUEUE: 'SET_REQUEST_QUEUE',
        COMPUTE_GRAPHS: 'COMPUTE_GRAPHS',
        COMPUTE_PATHS: 'COMPUTE_PATHS',
        SET_LAYOUT: 'SET_LAYOUT',
        SET_APP_LIFECYCLE: 'SET_APP_LIFECYCLE'
    };
    if (actionList[action]) return actionList[action];
    else throw new Error(`${action} is not defined.`)
};

export const updateProps = createAction(ACTIONS('ON_PROP_CHANGE'));
export const setRequestQueue = createAction(ACTIONS('SET_REQUEST_QUEUE'));
export const computeGraphs = createAction(ACTIONS('COMPUTE_GRAPHS'));
export const computePaths = createAction(ACTIONS('COMPUTE_PATHS'));
export const setLayout = createAction(ACTIONS('SET_LAYOUT'));
export const setAppLifecycle = createAction(ACTIONS('SET_APP_LIFECYCLE'));

export const hydrateInitialOutputs = function() {
    return function (dispatch, getState) {
        const {graphs} = getState();
        const {InputGraph} = graphs;
        const allNodes = InputGraph.overallOrder();
        allNodes.reverse();
        allNodes.forEach(nodeId => {
            const [componentId, componentProp] = nodeId.split('.');

            /*
             * Filter out the outputs,
             * inputs that aren't leaves,
             * and the invisible inputs
             */
            if (InputGraph.dependenciesOf(nodeId).length > 0 &&
                InputGraph.dependantsOf(nodeId).length == 0 &&
                has(componentId, getState().paths)
            ) {

                // Get the initial property
                const propLens = lensPath(
                    concat(getState().paths[componentId],
                    ['props', componentProp]
                ));
                const propValue = view(
                    propLens,
                    getState().layout
                );

                dispatch(notifyObservers({
                    id: componentId,
                    props: {[componentProp]: propValue}
                }));

            }
        });
        dispatch(setAppLifecycle('INITIALIZED'));
    }
}

export const notifyObservers = function(payload) {
    return function (dispatch, getState) {
        const {
            id,
            event,
            props
        } = payload

        const {
            layout,
            graphs,
            paths,
            requestQueue,
            dependenciesRequest
        } = getState();
        const {EventGraph, InputGraph} = graphs;

        /*
         * Figure out all of the output id's that depend on this
         * event or input.
         * This includes id's that are direct children as well as
         * grandchildren.
         * grandchildren will get filtered out in a later stage.
         */
        let outputObservers;
        if (event) {
            outputObservers = EventGraph.dependenciesOf(`${id}.${event}`);
        } else {
            const changedProps = keys(props);
            outputObservers = [];
            changedProps.forEach(propName => {
                InputGraph.dependenciesOf(`${id}.${propName}`).forEach(outputId =>
                    outputObservers.push(outputId)
                );
            });
        }

        if (isEmpty(outputObservers)) {
            return;
        }

        /*
         * There may be several components that depend on this input.
         * And some components may depend on other components before
         * updating. Get this update order straightened out.
         */
        const depOrder = InputGraph.overallOrder();
        outputObservers = sort(
            (a, b) => depOrder.indexOf(b) - depOrder.indexOf(a),
            outputObservers
        );
        const queuedObservers = [];
        outputObservers.forEach(function filterObservers(outputIdAndProp) {
            const outputComponentId = outputIdAndProp.split('.')[0];
            /*
             * before we make the POST, check that none of its input
             * dependencies are already in the queue.
             * if they are in the queue, then don't update.
             * when each dependency updates, it'll dispatch its own
             * `notifyObservers` action which will allow this
             * component to update.
             *
             * for example, if A updates B and C (A -> [B, C]) and B updates C
             * (B -> C), then when A updates, this logic will
             * reject C from the queue since it will end up getting updated
             * by B.
             *
             * in this case, B will already be in queuedObservers by the time
             * this loop hits C because of the overallOrder sorting logic
             */

            const controllersInQueue = intersection(
                queuedObservers,

                /*
                 * if the output just listens to events, then it won't be in
                 * the InputGraph
                 */
                InputGraph.hasNode(outputIdAndProp) ?
                InputGraph.dependantsOf(outputIdAndProp) : []
            );

            /*
             * also check that this observer is actually in the current
             * component tree.
             * observers don't actually need to be rendered at the moment
             * of a controller change.
             * for example, perhaps the user has hidden one of the observers
             */
             if (
                 (controllersInQueue.length === 0) &&
                 (has(outputComponentId, getState().paths))
             ) {
                 queuedObservers.push(outputIdAndProp)
             }
        });
        /*
         * record the set of output IDs that will eventually need to be
         * updated in a queue. not all of these requests will be fired in this
         * action
         */
        dispatch(setRequestQueue(union(queuedObservers, requestQueue)));

        for (let i = 0; i < queuedObservers.length; i++) {
            const outputIdAndProp = queuedObservers[i];
            const [outputComponentId, outputProp] = outputIdAndProp.split('.');

            /*
             * Construct a payload of the input, state, and event.
             * For example:
             * If the input triggered this update, then:
             * {
             *      inputs: [{'id': 'input1', 'property': 'new value'}],
             *      state: [{'id': 'state1', 'property': 'existing value'}]
             * }
             *
             * If an event triggered this udpate, then:
             * {
             *      state: [{'id': 'state1', 'property': 'existing value'}],
             *      event: {'id': 'graph', 'event': 'click'}
             * }
             *
             */
             const payload = {
                 output: {id: outputComponentId, property: outputProp}
             };

             if (event) {
                 payload.event = event;
             }

            const {inputs, state} = dependenciesRequest.content.find(
                dependency => (
                    dependency.output.id === outputComponentId &&
                    dependency.output.property === outputProp
                )
            )
            if (inputs.length > 0) {
                payload.inputs = inputs.map(inputObject => {
                    const propLens = lensPath(
                        concat(paths[inputObject.id],
                        ['props', inputObject.property]
                    ));
                    return {
                        id: inputObject.id,
                        property: inputObject.property,
                        value: view(propLens, layout)
                    };
                });
            }
            if (state.length > 0) {
                payload.state = state.map(stateObject => {
                    const propLens = lensPath(
                        concat(paths[stateObject.id],
                        ['props', stateObject.property]
                    ));
                    return {
                        id: stateObject.id,
                        property: stateObject.property,
                        value: view(propLens, layout)
                    };
                });
            }

            fetch('/update-component', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            }).then(response => response.json().then(function handleResponse(data) {
                // clear this item from the request queue
                dispatch(setRequestQueue(
                    reject(
                        id => id === outputIdAndProp,
                        getState().requestQueue
                    )
                ));

                // and update the props of the component
                const observerUpdatePayload = {
                    itempath: getState().paths[outputComponentId],
                    // new prop from the server
                    props: data.response.props
                };
                dispatch(updateProps(observerUpdatePayload));

                dispatch(notifyObservers({
                    id: outputComponentId,
                    props: data.response.props
                }));

                /*
                 * If the response includes content, then we need to update our
                 * paths store.
                 * TODO - Do we need to wait for updateProps to finish?
                 */
                if (has('content', observerUpdatePayload.props)) {

                    dispatch(computePaths({
                        subTree: observerUpdatePayload.props.content,
                        startingPath: concat(
                            getState().paths[outputComponentId],
                            ['props', 'content']
                        )
                    }));

                    /*
                     * if content contains objects with IDs, then we
                     * need to dispatch a propChange for all of these
                     * new children components
                     */
                    if (contains(
                            type(observerUpdatePayload.props.content),
                            ['Array', 'Object']
                        ) && !isEmpty(observerUpdatePayload.props.content)
                    ) {
                        /*
                         * TODO: We're just naively crawling
                         * the _entire_ layout to recompute the
                         * the dependency graphs.
                         * We don't need to do this - just need
                         * to compute the subtree
                         */
                        const newProps = [];
                        crawlLayout(
                            observerUpdatePayload.props.content,
                            function appendIds(child) {
                                if (hasId(child)) {
                                    keys(child.props).forEach(childProp => {
                                        const inputId = (
                                            `${child.props.id}.${childProp}`
                                        );
                                        if (has(inputId, InputGraph.nodes)) {
                                            newProps.push({
                                                id: child.props.id,
                                                props: {
                                                    [childProp]: child.props[childProp]
                                                }
                                            });
                                        }
                                    })
                                }
                            }
                        );

                        const depOrder = InputGraph.overallOrder();
                        const sortedNewProps = sort((a, b) =>
                            depOrder.indexOf(a.id) - depOrder.indexOf(b.id),
                            newProps
                        )
                        sortedNewProps.forEach(function(propUpdate) {
                            dispatch(notifyObservers(propUpdate));
                        });

                    }
                }


            }));

        }
    }
}
